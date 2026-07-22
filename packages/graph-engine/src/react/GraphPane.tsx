/**
 * GraphPane — ONE embeddable graph primitive.
 *
 * The React face of @fxyz/graph-engine: one implementation exposed through
 * presets, replacing several earlier ad-hoc mount points. Behavior enforced
 * here:
 *
 *  - preset ↔ payload.tier bind 1:1 (budget classes are server truth)
 *  - two-state overlay contract (overlay-machine.ts)
 *  - one-tap model: tap = inspect · double = navigate · HOVER BANNED
 *  - engine constructed ONCE per mount; data changes ingest incrementally —
 *    preset/backendFactory are frozen for the pane's life
 *  - labels are our budgeted overlay (the renderer's WebGL tier has no
 *    captions and the canvas tier's native captions are deliberately
 *    untriggered — one label system)
 *  - renderer picked from the measured node-count crossing, upgraded via
 *    LIVE setRenderer — no folklore constants
 *
 * Data is a prop (GraphPayloadV1) — the pane owns rendering + interaction,
 * never transport; consumers fetch via their surface's data path (GraphQL /
 * REST / static slice). Seed-driven fetching is expected to arrive as a
 * future runtime layered on top of this component, not inside it.
 */

import {
	DEFAULT_TIER_BUDGETS,
	type GraphEdgeV1,
	type GraphNodeV1,
	type GraphPayloadV1,
	type GraphRef,
	getLensSpec,
	type Tier,
} from "@fxyz/graph-contract";
import type {
	CSSProperties,
	ReactNode,
	PointerEvent as ReactPointerEvent,
	RefObject,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BackendFactory } from "../backend/contract";
import { GraphEngine } from "../core/engine";
import { pickLabeledNodes } from "../labels/budget";
import { DEFAULT_LAYOUT_POLICY, resolveLayout } from "../layout/policy";
import { sizeFromValue } from "../lens/apply";
import { type LabelNode, LabelOverlay } from "./label-overlay";
import { Minimap } from "./minimap";
import {
	initialOverlayState,
	isFullPagePreset,
	type OverlayEvent,
	type OverlayState,
	overlayReduce,
} from "./overlay-machine";
import { createPaneTracer, type PaneTracer } from "./pane-trace";
import { SETTLE_DEADLINE_MS, settleStep } from "./settle-policy";
import { TapClassifier } from "./tap-classifier";
import {
	EdgeHitIndex,
	mergeLivePositions,
	NodeHitIndex,
	type PaneView,
	panByScreenDelta,
	screenToWorld,
	zoomAround,
} from "./view";

/**
 * Canvas → WebGL seam. Measured: canvas comfortable to ~1–2k nodes (31fps at
 * 2k), so a threshold of 500 is directionally right — crossing uses live
 * setRenderer, never a reconstruction.
 */
const WEBGL_NODE_SEAM = 500;

/** The renderer draws node `size` as a DIAMETER (radius = size/2); 25 is the
 * default for nodes no size rule touches. */
const DEFAULT_NODE_SIZE = 25;

/** Tap-acknowledgment camera ease (ms) — the click must move the world. */
const TAP_TWEEN_MS = 320;

/** Cursor-affordance hit-test cadence (≥25ms, zoom parity — the spatial grid
 * bounds cost per query, this bounds queries per second). */
const CURSOR_HIT_INTERVAL_MS = 25;

/** prefers-reduced-motion at call time (SSR-safe): camera moves must land
 * instantly for members who asked motion to stop — spinners already comply,
 * the tap tween must too. */
function reducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

export class PaneViolation extends Error {
	constructor(message: string) {
		super(`[graph-pane] ${message}`);
		this.name = "PaneViolation";
	}
}

export interface GraphPaneProps {
	/** Budget class — binds 1:1 to payload.tier. */
	preset: Tier;
	/** Contract payload; null = loading. The pane never fetches. */
	payload: GraphPayloadV1 | null;
	/**
	 * Renderer backend, injected: apps pass createNvlBackendFactory with a
	 * constructor for the underlying renderer instance.
	 */
	backendFactory: BackendFactory;
	/** Known lens id (contract registry) — applies its styleRules. */
	lens?: string;
	/** Surface property, NOT a budget property. Default: workbench/atlas. */
	fullPage?: boolean;
	onInspect?: (ref: GraphRef, node: GraphNodeV1) => void;
	/**
	 * Fires when a tap lands on empty canvas — the lawful deselect (without
	 * it, selection + consumer inspect cards were sticky forever). On
	 * UNCONTROLLED surfaces (no selectedRefs prop) the
	 * engine highlight is cleared before this fires; on CONTROLLED surfaces
	 * the consumer owns selection — close the card here and let the state
	 * loop clear (or deliberately keep) the highlight.
	 */
	onInspectClear?: () => void;
	/**
	 * One-tap EDGE inspect: fires when a tap lands on an edge and no node is
	 * under it (nodes win). Wiring this prop is what turns edge hit-testing
	 * ON — the segment index is built lazily and only for consumers that
	 * inspect edges (a consumer gate). On uncontrolled surfaces the tapped
	 * edge lights through the explicit-edge channel.
	 */
	onInspectEdge?: (id: string, edge: GraphEdgeV1) => void;
	onNavigate?: (ref: GraphRef, node: GraphNodeV1) => void;
	onOverlayChange?: (state: OverlayState) => void;
	/**
	 * Inset minimap (Active state only): full node field + live viewport
	 * rect, press/drag jumps the camera. Opt-in — full-page workbench-class
	 * surfaces want it; tiles/drawers don't have the pixels.
	 */
	minimap?: boolean;
	/**
	 * Member node drag: pointer-down ON a node + drag moves THAT node
	 * (session-local pin, never written back — server positions stay truth);
	 * drag on empty canvas pans, unchanged. Tap grammar untouched (tap =
	 * inspect, double = navigate). Opt-in — workbench-class surfaces where
	 * members untangle neighborhoods; guided public panes stay pan-only.
	 */
	dragNodes?: boolean;
	/**
	 * Controlled selection (id-keyed): the surface's mechanic for
	 * emphasizing a path/cycle — selection is the ONE lawful highlight (no
	 * hover, no bespoke pulse). Tap-selection still works between changes.
	 */
	selectedRefs?: GraphRef[];
	/**
	 * Controlled explicit edge selection (routing-path hero): lights
	 * EXACTLY these edge ids through the lawful highlight + salience channel,
	 * independent of node-incident selection. Replaces the previous set on
	 * change. For path/cycle surfaces (arbitrage, optimal route) that emphasise
	 * an edge SET rather than a node's neighbourhood.
	 */
	selectedEdgeIds?: string[];
	/**
	 * Fires once per ingested payload when the layout stops moving (ms since
	 * ingest) — the settle HUD hook. Under `free` (server positions) this is
	 * effectively immediate. Implemented as an rAF poll of the backend's
	 * motion flag; no backend-contract change.
	 */
	onSettled?: (ms: number) => void;
	/**
	 * Label chrome-exclusion band, css px from the pane top — for surfaces
	 * whose toolbars/hints live INSIDE the pane (workbench tabs, public lens
	 * switcher): labels never render under that chrome. Default 0.
	 */
	labelTopInset?: number;
	/** Visible exit affordance text (consumer localizes). */
	exitLabel?: string;
	renderLoading?: () => ReactNode;
	renderEmpty?: () => ReactNode;
	className?: string;
	style?: CSSProperties;
	ariaLabel?: string;
}

const rootStyle: CSSProperties = {
	position: "relative",
	width: "100%",
	height: "100%",
	overflow: "hidden",
};

const canvasHostStyle: CSSProperties = {
	position: "absolute",
	inset: 0,
};

const exitStyle: CSSProperties = {
	position: "absolute",
	top: 8,
	right: 8,
	zIndex: 3,
	padding: "2px 8px",
	fontSize: 11,
	letterSpacing: "0.04em",
	cursor: "pointer",
	borderRadius: 0,
};

export function GraphPane({
	preset,
	payload,
	backendFactory,
	lens,
	fullPage,
	onInspect,
	onInspectClear,
	onInspectEdge,
	onNavigate,
	onOverlayChange,
	selectedRefs,
	selectedEdgeIds,
	onSettled,
	labelTopInset,
	exitLabel,
	minimap,
	dragNodes,
	renderLoading,
	renderEmpty,
	className,
	style,
	ariaLabel,
}: GraphPaneProps) {
	const isFullPage = fullPage ?? isFullPagePreset(preset);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const engineRef = useRef<GraphEngine | null>(null);
	const ingestedRef = useRef<GraphPayloadV1 | null>(null);
	const hitRef = useRef<NodeHitIndex | null>(null);
	// Edge index: lazy + consumer-gated (built on the first tap that needs it,
	// only when onInspectEdge is wired) — invalidated whenever the node index
	// refreshes so both always read the same position truth.
	const edgeHitRef = useRef<EdgeHitIndex | null>(null);
	const tapRef = useRef(new TapClassifier());
	// Diagnostics: freeze-surviving interaction breadcrumbs, OFF unless the
	// member armed `?paneTrace=1` — see pane-trace.ts.
	const tracerRef = useRef<PaneTracer | null>(null);
	if (tracerRef.current === null) tracerRef.current = createPaneTracer();
	const pointersRef = useRef(new Map<number, { x: number; y: number }>());
	const pinchRef = useRef<{ dist: number } | null>(null);
	// Node under the current press (dragNodes surfaces only): once the
	// classifier crosses slop, the gesture moves THIS node instead of panning.
	// Grab offset is world-space so the disc doesn't snap its center to the
	// pointer. Cleared on release/cancel/pinch.
	const dragNodeRef = useRef<{
		ref: GraphRef;
		grabDX: number;
		grabDY: number;
	} | null>(null);
	const rendererRef = useRef<"canvas" | "webgl">("canvas");
	// Live-layout truth: the resolved layout for this mount, and whether the
	// current payload's sim has settled. `free` is born settled.
	const layoutRef = useRef<"free" | "d3Force">("free");
	const settledRef = useRef(true);
	// Tap-acknowledgment tween handle — any new gesture cancels it.
	const tweenRafRef = useRef(0);
	// Cursor affordance: is the (up) pointer over a hittable node? Ref guards
	// the setState to actual flips — never a per-move re-render.
	const hoverHitRef = useRef(false);
	const [hoverHit, setHoverHit] = useState(false);
	// Time gate for the cursor-affordance hit-test.
	const cursorHitAtRef = useRef(Number.NEGATIVE_INFINITY);

	// Config identity: the values the engine was constructed with are frozen
	// for the pane's life — a change is a violation, not a re-render.
	const frozen = useRef<{ preset: Tier; factory: BackendFactory } | null>(null);
	if (frozen.current) {
		if (frozen.current.preset !== preset) {
			throw new PaneViolation(
				`preset changed '${frozen.current.preset}' → '${preset}' mid-life — mount a new pane`,
			);
		}
		if (frozen.current.factory !== backendFactory) {
			throw new PaneViolation(
				"backendFactory changed mid-life — mount a new pane",
			);
		}
	}

	const [overlay, setOverlay] = useState<OverlayState>(
		isFullPage ? "active" : initialOverlayState(preset),
	);
	// Raw transform (scale/pan) mirrors the backend; the full PaneView derives
	// per render so container resizes keep the center-origin transform honest.
	const [rawView, setRawView] = useState({ scale: 1, panX: 0, panY: 0 });
	// Settled sim positions (client-sim mounts only) — labels attach to these;
	// null under `free`, where payload positions are already render truth.
	const [livePositions, setLivePositions] = useState<Record<
		string,
		{ x: number; y: number }
	> | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const view: PaneView = useMemo(
		() => ({
			...rawView,
			width: size.width,
			height: size.height,
			dpr: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
		}),
		[rawView, size],
	);

	const dispatchOverlay = useCallback(
		(event: OverlayEvent): boolean => {
			let consumed = false;
			setOverlay((state) => {
				const decision = overlayReduce(state, event, { fullPage: isFullPage });
				consumed = decision.consumed;
				if (decision.state !== state) onOverlayChange?.(decision.state);
				return decision.state;
			});
			return consumed;
		},
		[isFullPage, onOverlayChange],
	);

	/** Read the live transform back from the backend (after fit). */
	const syncView = useCallback(() => {
		const engine = engineRef.current;
		if (!engine) return;
		const scale = engine.backend.getScale();
		const pan = engine.backend.getPan();
		if (!Number.isFinite(scale) || scale <= 0) return;
		setRawView({ scale, panX: pan.x, panY: pan.y });
	}, []);

	const applyView = useCallback((next: PaneView) => {
		const engine = engineRef.current;
		if (!engine) return;
		engine.backend.setZoomAndPan(next.scale, next.panX, next.panY);
		setRawView({ scale: next.scale, panX: next.panX, panY: next.panY });
	}, []);

	const cancelTween = useCallback(() => {
		if (tweenRafRef.current) {
			cancelAnimationFrame(tweenRafRef.current);
			tweenRafRef.current = 0;
		}
	}, []);

	/**
	 * Ease the camera so the tapped node lands center-frame (a tap that only
	 * updates a side card reads as dead). Pan-only — zoom is the member's own
	 * gesture; the transform is center-origin, so "centered" is pan = node's
	 * world position. Any new gesture cancels it.
	 */
	const tweenCameraTo = useCallback(
		(worldX: number, worldY: number) => {
			cancelTween();
			const backend = engineRef.current?.backend;
			if (!backend) return;
			const scale = backend.getScale();
			const from = backend.getPan();
			if (!Number.isFinite(scale) || scale <= 0) return;
			if (reducedMotion()) {
				// Same destination, zero motion — the acknowledgment is the
				// centered result, not the flight.
				backend.setZoomAndPan(scale, worldX, worldY);
				setRawView({ scale, panX: worldX, panY: worldY });
				return;
			}
			const start = performance.now();
			const step = (now: number) => {
				const k = Math.min(1, (now - start) / TAP_TWEEN_MS);
				const ease = 1 - (1 - k) ** 3;
				const panX = from.x + (worldX - from.x) * ease;
				const panY = from.y + (worldY - from.y) * ease;
				engineRef.current?.backend.setZoomAndPan(scale, panX, panY);
				setRawView({ scale, panX, panY });
				tweenRafRef.current = k < 1 ? requestAnimationFrame(step) : 0;
			};
			tweenRafRef.current = requestAnimationFrame(step);
		},
		[cancelTween],
	);

	/**
	 * Rebuild the tap hit-index from the backend's CURRENT positions — the
	 * principle that hit-testing reads the same position source the renderer
	 * draws from. Under `free` the payload index never drifts; under a client
	 * sim this runs at settle and for taps that land mid-sim.
	 */
	const refreshHitIndex = useCallback(() => {
		const engine = engineRef.current;
		const ingested = ingestedRef.current;
		if (!engine || !ingested) return;
		hitRef.current = new NodeHitIndex(
			mergeLivePositions(ingested.nodes, engine.backend.getNodePositions()),
		);
		edgeHitRef.current = null; // rebuilt lazily from the same fresh truth
	}, []);

	/** Build the edge index on demand (consumer-gated). */
	const ensureEdgeIndex = useCallback(() => {
		if (edgeHitRef.current) return;
		const engine = engineRef.current;
		const ingested = ingestedRef.current;
		if (!engine || !ingested) return;
		edgeHitRef.current = new EdgeHitIndex(
			ingested.edges,
			mergeLivePositions(ingested.nodes, engine.backend.getNodePositions()),
		);
	}, []);

	// Ingest path — engine constructed lazily on FIRST payload (post-commit,
	// so the canvas host exists), later payloads diff into the same engine.
	// biome-ignore lint/correctness/useExhaustiveDependencies: ingest deps are frozen by design (see the config-identity check above)
	useEffect(() => {
		if (!payload || ingestedRef.current === payload) return;
		if (payload.tier !== preset) {
			throw new PaneViolation(
				`payload tier '${payload.tier}' does not match preset '${preset}' — tiers and presets bind 1:1`,
			);
		}
		if (payload.nodes.length === 0) {
			// Empty renders the EmptyState branch; nothing to ingest.
			ingestedRef.current = payload;
			return;
		}
		const host = hostRef.current;
		if (!host) return;
		let engine = engineRef.current;
		if (!engine) {
			const layout = resolveLayout(DEFAULT_LAYOUT_POLICY, payload);
			layoutRef.current = layout;
			rendererRef.current =
				payload.nodes.length > WEBGL_NODE_SEAM ? "webgl" : "canvas";
			engine = new GraphEngine(backendFactory, {
				container: host,
				renderer: rendererRef.current,
				layout,
				disableTelemetry: true,
				// Explicit zoom bounds (real engine levers, never left implicit):
				// without these the renderer's default cap clamps setZoomAndPan
				// below the deterministic fit's target on large dpr-2 displays
				// (the overview cloud reads small in a big viewport otherwise).
				// Matches zoomAround's own clamp range.
				minZoom: 0.02,
				maxZoom: 8,
				// Client-sim mounts only (free ignores it): the simulation stops
				// churning at the SAME deadline the settle policy adopts positions
				// at — one 8s truth, not two clocks. relationshipThreshold and
				// allowDynamicMinZoom stay DELIBERATELY unset: the first only
				// gates native rel captions (banned — labels are our overlay);
				// the second would fight the explicit minZoom above.
				layoutTimeLimit: SETTLE_DEADLINE_MS,
			});
			engineRef.current = engine;
			frozen.current = { preset, factory: backendFactory };
		} else if (
			rendererRef.current === "canvas" &&
			payload.nodes.length > WEBGL_NODE_SEAM
		) {
			engine.backend.setRenderer("webgl"); // live crossing
			rendererRef.current = "webgl";
		}
		engine.ingest(payload);
		ingestedRef.current = payload;
		hitRef.current = new NodeHitIndex(payload.nodes);
		edgeHitRef.current = null;
		const spec = lens ? getLensSpec(lens) : null;
		if (spec && spec.styleRules.length > 0) {
			engine.applyLens(spec.styleRules);
		}
		// The one fit happened inside ingest (first data-ready) — read the
		// resulting transform back once the backend has applied it.
		requestAnimationFrame(syncView);
	}, [payload]);

	// Controlled selection — re-applied when the refs change or a new payload
	// lands (ingest re-adds nodes). Declared after the ingest effect so the
	// engine exists by the time this runs on a payload commit. Centering on
	// the first selected ref makes a controlled jump (saved view / ?focusRef=)
	// land the target in frame — same acknowledgment behavior as the tap.
	// biome-ignore lint/correctness/useExhaustiveDependencies: payload is a deliberate re-apply trigger
	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || !selectedRefs) return;
		engine.select(selectedRefs);
		const first = selectedRefs[0];
		const node = first
			? ingestedRef.current?.nodes.find((n) => n.id === first)
			: undefined;
		if (
			node &&
			Number.isFinite(node.x as number) &&
			Number.isFinite(node.y as number)
		) {
			tweenCameraTo(node.x as number, node.y as number);
		}
	}, [selectedRefs, payload]);

	// Controlled explicit edge selection — re-applied when the ids change or a
	// new payload lands (ingest re-adds edges). Independent of node selection;
	// the routing-path hero lights an edge SET through the same lawful
	// salience channel.
	// biome-ignore lint/correctness/useExhaustiveDependencies: payload is a deliberate re-apply trigger
	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || !selectedEdgeIds) return;
		engine.selectEdges(selectedEdgeIds);
	}, [selectedEdgeIds, payload]);

	// Live lens switch: a lens change re-styles through the engine's
	// incremental applyLens — never a reconstruction, never a re-ingest. The
	// ingest path applies the CURRENT lens on payload commit; this effect only
	// fires on lens identity changes afterward.
	// biome-ignore lint/correctness/useExhaustiveDependencies: ingest applies the lens on payload change; this reacts to lens only
	useEffect(() => {
		const engine = engineRef.current;
		if (!engine || !ingestedRef.current) return;
		const spec = lens ? getLensSpec(lens) : null;
		engine.applyLens(spec?.styleRules ?? []);
	}, [lens]);

	// Settle watcher: polls the backend's motion flag per rAF, once per
	// ingested payload. ALWAYS on for client-sim mounts (settle is when the
	// hit index + label overlay adopt the sim's real positions and the camera
	// re-syncs); pure opt-in reporting under `free`. One state write per
	// ingest — never a per-frame setState.
	//
	// CHURN IMMUNITY: the watcher's lifetime must be per-INGEST, not
	// per-render. With onSettled/syncView/refreshHitIndex in the deps, any
	// consumer re-render with a fresh callback identity (some consumer
	// surfaces re-render around a ticking clock) tore the effect down and
	// RESET the deadline clock — the 8s adoption became unreachable on
	// exactly the surfaces that needed it, while ε-quiescence kept "working"
	// because the backend's motion flag survives effect restarts. Callbacks
	// are therefore read through a per-render ref and the effect keys on the
	// payload alone.
	// PAYLOAD-IDENTITY IMMUNITY: consumers that hand the pane a fresh payload
	// OBJECT each render (same content, new reference) restarted the watcher
	// through a [payload] dep just like the callback churn did. The watcher
	// therefore keys on the payload's CONTENT identity (contract cacheKey) —
	// a re-render with the same cacheKey continues the same settle session.
	const settleCallbacksRef = useRef({ onSettled, syncView, refreshHitIndex });
	settleCallbacksRef.current = { onSettled, syncView, refreshHitIndex };
	const settleKey = payload ? payload.cacheKey : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: churn immunity — callbacks ride settleCallbacksRef, the payload rides its content key, by design
	useEffect(() => {
		if (!payload || payload.nodes.length === 0) return;
		const isSim = layoutRef.current !== "free";
		settledRef.current = !isSim;
		if (!isSim && !settleCallbacksRef.current.onSettled) return;
		const start = performance.now();
		let raf = 0;
		let stopped = false;
		// Bounded settle: micro-jitter under alphaDecay 0 can hold ε-quiescence
		// off for a long tail; the settle-policy machine adopts positions at the
		// deadline and lets true quiescence land one final correction.
		let adopted = false;
		const tick = () => {
			if (stopped) return;
			const engine = engineRef.current;
			if (!engine) {
				raf = requestAnimationFrame(tick);
				return;
			}
			const action = settleStep({
				isSim,
				moving: engine.backend.isLayoutMoving(),
				adopted,
				elapsedMs: performance.now() - start,
			});
			if (action.adopt) {
				settledRef.current = true;
				settleCallbacksRef.current.syncView();
				settleCallbacksRef.current.refreshHitIndex();
				setLivePositions(engine.backend.getNodePositions());
			}
			if (action.fireOnSettled) {
				adopted = true;
				settleCallbacksRef.current.onSettled?.(
					Math.round(performance.now() - start),
				);
			}
			if (action.done) return;
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			stopped = true;
			cancelAnimationFrame(raf);
		};
	}, [settleKey]);

	// Size observation + engine teardown. Cleanup resets the ingest marker so
	// a StrictMode remount (or real remount) reconstructs and re-ingests.
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const ro = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (rect) setSize({ width: rect.width, height: rect.height });
		});
		ro.observe(root);
		return () => {
			ro.disconnect();
			if (tweenRafRef.current) cancelAnimationFrame(tweenRafRef.current);
			engineRef.current?.destroy();
			engineRef.current = null;
			ingestedRef.current = null;
			frozen.current = null;
		};
	}, []);

	// Exit-class listeners (Active, embedded panes only).
	useActiveExitEffects({
		enabled: overlay === "active" && !isFullPage,
		rootRef,
		onExit: dispatchOverlay,
	});

	// Wheel zoom: Active only, non-passive (must preventDefault to stop page
	// scroll). Preview attaches NO wheel handler — the page scrolls through.
	useWheelZoom({
		enabled: overlay === "active" && !!payload && payload.nodes.length > 0,
		rootRef,
		onWheel: (cx, cy, factor) => {
			cancelTween();
			applyView(zoomAround(view, cx, cy, factor));
		},
	});

	// ---- pointer interaction (hand-wired: the renderer has zero touch events) -------

	/** The backend's LIVE transform as a PaneView (hit-testing and drag math
	 *  read the renderer's truth, never a stale state snapshot). */
	const liveHitView = useCallback((): PaneView => {
		const backend = engineRef.current?.backend;
		if (backend) {
			const scale = backend.getScale();
			const pan = backend.getPan();
			if (Number.isFinite(scale) && scale > 0) {
				return { ...view, scale, panX: pan.x, panY: pan.y };
			}
		}
		return view;
	}, [view]);

	const handlePointerDown = useCallback(
		(e: ReactPointerEvent) => {
			cancelTween();
			pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pointersRef.current.size === 2) {
				const [a, b] = [...pointersRef.current.values()];
				pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
				tapRef.current.cancel();
				dragNodeRef.current = null; // pinch outranks a node drag
				return;
			}
			const rect = rootRef.current?.getBoundingClientRect();
			if (!rect) return;
			const x = e.clientX - rect.left;
			const y = e.clientY - rect.top;
			tapRef.current.down(x, y);
			// Node-drag arm: ONE bounded spatial-grid query per press (same cost
			// class as the tap hit-test). The gesture only becomes a node drag
			// if the classifier later crosses slop.
			dragNodeRef.current = null;
			if (dragNodes && overlay === "active") {
				if (!settledRef.current) refreshHitIndex();
				const hv = liveHitView();
				const node = hitRef.current?.hit(hv, x, y) ?? null;
				if (
					node &&
					Number.isFinite(node.x as number) &&
					Number.isFinite(node.y as number)
				) {
					const wpt = screenToWorld(hv, x, y);
					dragNodeRef.current = {
						ref: node.id,
						grabDX: (node.x as number) - wpt.x,
						grabDY: (node.y as number) - wpt.y,
					};
				}
			}
		},
		[cancelTween, dragNodes, overlay, liveHitView, refreshHitIndex],
	);

	const handlePointerMove = useCallback(
		(e: ReactPointerEvent) => {
			const pointers = pointersRef.current;
			const prev = pointers.get(e.pointerId);
			if (!prev) {
				// No pointer down: cursor affordance only (otherwise nothing
				// signals clickability). A bounded spatial-grid query per move;
				// NO styling, NO state machine — the hover-highlight ban is
				// untouched. Time half of the same bound: ≥25ms between queries
				// (zoom parity) — the spatial grid bounds cost per query, this
				// bounds queries per second.
				if (overlay !== "active") return;
				const t = performance.now();
				if (t - cursorHitAtRef.current < CURSOR_HIT_INTERVAL_MS) return;
				cursorHitAtRef.current = t;
				const rect = rootRef.current?.getBoundingClientRect();
				if (!rect) return;
				const over =
					hitRef.current?.hit(
						view,
						e.clientX - rect.left,
						e.clientY - rect.top,
						16,
					) != null;
				if (over !== hoverHitRef.current) {
					hoverHitRef.current = over;
					setHoverHit(over);
				}
				return;
			}
			const rect = rootRef.current?.getBoundingClientRect();
			if (!rect) return;
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

			if (overlay !== "active") return; // Preview: browser owns gestures

			if (pointers.size === 2 && pinchRef.current) {
				const [a, b] = [...pointers.values()];
				const dist = Math.hypot(a.x - b.x, a.y - b.y);
				if (dist > 0 && pinchRef.current.dist > 0) {
					const cx = (a.x + b.x) / 2 - rect.left;
					const cy = (a.y + b.y) / 2 - rect.top;
					applyView(zoomAround(view, cx, cy, dist / pinchRef.current.dist));
				}
				pinchRef.current = { dist };
				return;
			}

			tapRef.current.move(e.clientX - rect.left, e.clientY - rect.top);
			if (tapRef.current.isDragging()) {
				const drag = dragNodeRef.current;
				if (drag) {
					// Node drag: the camera holds still; the node rides the pointer
					// in world space. Labels/minimap re-join on release (per-move
					// livePositions would re-rank thousands of labels per event).
					const wpt = screenToWorld(
						liveHitView(),
						e.clientX - rect.left,
						e.clientY - rect.top,
					);
					engineRef.current?.overrideNodePosition(
						drag.ref,
						wpt.x + drag.grabDX,
						wpt.y + drag.grabDY,
					);
				} else {
					applyView(
						panByScreenDelta(view, e.clientX - prev.x, e.clientY - prev.y),
					);
				}
			}
		},
		[applyView, overlay, view, liveHitView],
	);

	const handlePointerUp = useCallback(
		(e: ReactPointerEvent) => {
			pointersRef.current.delete(e.pointerId);
			if (pointersRef.current.size < 2) pinchRef.current = null;
			const rect = rootRef.current?.getBoundingClientRect();
			if (!rect) return;
			const x = e.clientX - rect.left;
			const y = e.clientY - rect.top;
			const outcome = tapRef.current.up(x, y);
			const tr = tracerRef.current;
			const traceEnd = tr?.enabled
				? tr.phase(`up ${outcome ?? "none"} ${Math.round(x)},${Math.round(y)}`)
				: null;
			try {
				// Node-drag release: the moved truth re-enters every consumer of
				// positions — hit index (edge index invalidates with it) and the
				// livePositions join labels + minimap read.
				const dragged = dragNodeRef.current;
				dragNodeRef.current = null;
				if (outcome === "drag" && dragged) {
					refreshHitIndex();
					const positions = engineRef.current?.backend.getNodePositions();
					if (positions) setLivePositions(positions);
					return;
				}
				if (outcome !== "tap" && outcome !== "double") return;

				// Activation tap: consumed, never a select.
				if (dispatchOverlay("tap")) return;

				// Taps read the renderer's truth — refresh the index for mid-sim
				// taps, and hit-test against the backend's LIVE transform (never a
				// stale state snapshot).
				if (!settledRef.current) refreshHitIndex();
				const hitView = liveHitView();
				const node = hitRef.current?.hit(hitView, x, y) ?? null;
				if (tr?.enabled) tr.crumb(`hit ${node ? node.id : "none"}`);
				if (!node) {
					// Edge inspect: only when no node is under the tap, and only
					// for surfaces that wired an edge consumer — the
					// segment index doesn't exist otherwise (consumer gate).
					if (onInspectEdge && outcome === "tap") {
						const edgeIdxEnd = tr?.enabled ? tr.phase("edgeIndex+hit") : null;
						ensureEdgeIndex();
						const edge = edgeHitRef.current?.hit(hitView, x, y) ?? null;
						edgeIdxEnd?.();
						if (tr?.enabled) tr.crumb(`edgeHit ${edge ? edge.id : "none"}`);
						if (edge) {
							if (selectedEdgeIds === undefined) {
								engineRef.current?.selectEdges([edge.id]);
							}
							onInspectEdge(edge.id, edge);
							return;
						}
					}
					// Empty tap = the lawful deselect. UNCONTROLLED surfaces clear the
					// engine highlight here; CONTROLLED surfaces (selectedRefs prop —
					// route ribbons, seeded emphasis) own their selection, so only the
					// callback fires and the consumer decides (its state loop clears
					// the ring when the card closes, or keeps a computed highlight).
					if (selectedRefs === undefined) engineRef.current?.select([]);
					if (selectedEdgeIds === undefined && onInspectEdge) {
						engineRef.current?.selectEdges([]);
					}
					onInspectClear?.();
					return;
				}
				engineRef.current?.select([node.id]);
				if (
					Number.isFinite(node.x as number) &&
					Number.isFinite(node.y as number)
				) {
					tweenCameraTo(node.x as number, node.y as number);
				}
				if (outcome === "double") onNavigate?.(node.id, node);
				else onInspect?.(node.id, node);
			} finally {
				traceEnd?.();
			}
		},
		[
			dispatchOverlay,
			onInspect,
			onInspectClear,
			onInspectEdge,
			onNavigate,
			liveHitView,
			refreshHitIndex,
			ensureEdgeIndex,
			tweenCameraTo,
			selectedRefs,
			selectedEdgeIds,
		],
	);

	const handlePointerCancel = useCallback((e: ReactPointerEvent) => {
		pointersRef.current.delete(e.pointerId);
		pinchRef.current = null;
		tapRef.current.cancel();
		dragNodeRef.current = null;
	}, []);

	// ---- labels (budgeted overlay) -------------------------------------------
	const labelNodes = useMemo<LabelNode[]>(() => {
		if (!payload) return [];
		const spec = lens ? getLensSpec(lens) : null;
		const budget =
			spec?.labelBudget ?? DEFAULT_TIER_BUDGETS[preset].labelBudget.value;
		const picked = pickLabeledNodes(
			payload.nodes,
			budget,
			spec?.labelRankMeasure,
		);
		// Client-sim mounts: labels attach to the settled sim positions
		// (payload nodes carry no coordinates under a sim, so without this
		// join the overlay rendered zero labels).
		const positioned = livePositions
			? mergeLivePositions(picked, livePositions)
			: picked;
		// Anchor radius mirrors the lens's own size rule (same sizeFromValue
		// math the style pipeline pushes to the backend) so labels sit at the
		// node's rendered EDGE, not its center (otherwise labels visibly
		// float off their nodes). The renderer's size is a diameter — radius
		// is half.
		const sizeRule = spec?.styleRules.find(
			(r) => r.channel === "size" && !r.source.startsWith("prop:"),
		);
		return positioned.map((n) => {
			const measured = sizeRule
				? n.measures?.[sizeRule.source as keyof NonNullable<typeof n.measures>]
				: undefined;
			const size =
				typeof measured === "number"
					? sizeFromValue(measured)
					: DEFAULT_NODE_SIZE;
			return { ...n, anchorRadius: size / 2 };
		});
	}, [payload, lens, preset, livePositions]);

	// Minimap reads the FULL positioned node field (never the label-budget
	// subset) — same live-position join as labels/hit-testing.
	const minimapNodes = useMemo<GraphNodeV1[]>(() => {
		if (!minimap || !payload) return [];
		return livePositions
			? mergeLivePositions(payload.nodes, livePositions)
			: payload.nodes;
	}, [minimap, payload, livePositions]);

	// ---- render ---------------------------------------------------------------
	const state = !payload
		? "loading"
		: payload.nodes.length === 0
			? "empty"
			: overlay;

	return (
		<div
			ref={rootRef}
			className={className}
			style={{
				...rootStyle,
				touchAction: state === "active" ? "none" : "pan-y",
				cursor:
					state === "active"
						? hoverHit
							? "pointer"
							: "grab"
						: state === "preview"
							? "pointer"
							: undefined,
				...style,
			}}
			data-graphpane={state}
			aria-label={ariaLabel}
			aria-busy={state === "loading" || undefined}
			onPointerDown={
				state === "active" || state === "preview"
					? handlePointerDown
					: undefined
			}
			onPointerMove={
				state === "active" || state === "preview"
					? handlePointerMove
					: undefined
			}
			onPointerUp={
				state === "active" || state === "preview" ? handlePointerUp : undefined
			}
			onPointerCancel={
				state === "active" || state === "preview"
					? handlePointerCancel
					: undefined
			}
		>
			{state === "loading" ? (renderLoading?.() ?? null) : null}
			{state === "empty"
				? (renderEmpty?.() ?? (
						<span data-graphpane-empty-default>No graph data available.</span>
					))
				: null}
			<div
				ref={hostRef}
				style={{
					...canvasHostStyle,
					display:
						state === "loading" || state === "empty" ? "none" : undefined,
				}}
				data-graphpane-canvas
			/>
			{state === "active" || state === "preview" ? (
				<LabelOverlay
					nodes={labelNodes}
					view={view}
					width={size.width}
					height={size.height}
					topInset={labelTopInset}
				/>
			) : null}
			{state === "active" && minimap ? (
				<Minimap
					nodes={minimapNodes}
					view={view}
					onJump={(wx, wy) => {
						cancelTween();
						applyView({ ...view, panX: wx, panY: wy });
					}}
				/>
			) : null}
			{state === "active" && !isFullPage ? (
				<button
					type="button"
					style={exitStyle}
					data-graphpane-exit
					onClick={() => dispatchOverlay("exit-affordance")}
				>
					{exitLabel ?? "Esc"}
				</button>
			) : null}
		</div>
	);
}

/** Esc / outside-pointer / IntersectionObserver exits while Active. */
function useActiveExitEffects(args: {
	enabled: boolean;
	rootRef: RefObject<HTMLDivElement | null>;
	onExit: (event: OverlayEvent) => void;
}) {
	const { enabled, rootRef, onExit } = args;
	useEffect(() => {
		if (!enabled) return;
		const root = rootRef.current;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onExit("esc");
		};
		const onDocPointer = (e: PointerEvent) => {
			if (root && e.target instanceof Node && !root.contains(e.target)) {
				onExit("outside-pointer");
			}
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onDocPointer);
		let io: IntersectionObserver | null = null;
		if (root && typeof IntersectionObserver !== "undefined") {
			io = new IntersectionObserver(
				(entries) => {
					const entry = entries[0];
					if (entry && entry.intersectionRatio < 0.4) onExit("viewport-exit");
				},
				{ threshold: [0.4] },
			);
			io.observe(root);
		}
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onDocPointer);
			io?.disconnect();
		};
	}, [enabled, rootRef, onExit]);
}

/** Non-passive wheel binding (React's synthetic wheel can't preventDefault). */
function useWheelZoom(args: {
	enabled: boolean;
	rootRef: RefObject<HTMLDivElement | null>;
	onWheel: (centerX: number, centerY: number, factor: number) => void;
}) {
	const { enabled, rootRef, onWheel } = args;
	useEffect(() => {
		if (!enabled) return;
		const root = rootRef.current;
		if (!root) return;
		const handler = (e: WheelEvent) => {
			e.preventDefault();
			const rect = root.getBoundingClientRect();
			onWheel(
				e.clientX - rect.left,
				e.clientY - rect.top,
				Math.exp(-e.deltaY * 0.0015),
			);
		};
		root.addEventListener("wheel", handler, { passive: false });
		return () => root.removeEventListener("wheel", handler);
	}, [enabled, rootRef, onWheel]);
}
