/**
 * Backend adapter for an injected rendering engine instance.
 *
 * The adapter takes an INJECTED instance factory rather than importing a
 * rendering library directly — production wiring
 * passes `(container, nodes, rels, opts) => new Renderer(container, nodes,
 * rels, opts)`; tests pass a fake. This keeps the engine package
 * dependency-free while preserving the seam: this
 * remains the only module allowed to touch the underlying rendering library.
 *
 * Live `setRenderer()` is used on the 500-node-crossing instead of a
 * destroy+recreate cycle — measured working against the current renderer
 * version.
 */

import {
	assertTelemetryDisabled,
	type BackendConstructOptions,
	type BackendNode,
	type BackendRel,
	type GraphBackend,
} from "./contract";

/**
 * Structural type of the renderer surface this adapter touches. Return
 * shapes are intentionally minimal (`id` only, no index signature) so the
 * real renderer class instance is assignable without casts at injection
 * sites — extra fields ride through the adapter's spreads untyped.
 */
export interface NvlLikeInstance {
	getNodes(): Array<{ id: string | number }>;
	getRelationships(): Array<{ id: string | number }>;
	getNodePositions?(): Array<{ id: string | number; x?: number; y?: number }>;
	setNodePositions(positions?: unknown[], render?: boolean): void;
	addAndUpdateElementsInGraph(nodes?: unknown[], rels?: unknown[]): void;
	removeNodesWithIds(ids: string[]): void;
	removeRelationshipsWithIds(ids: string[]): void;
	getSelectedNodes?(): Array<{ id: string | number }>;
	deselectAll?(): void;
	// Renderer asymmetry (verified against its type defs + bundle): pin takes
	// ONE id, unpin an ARRAY.
	pinNode?(nodeId: string): void;
	unPinNode?(nodeIds: string[]): void;
	setZoomAndPan(zoom: number, x: number, y: number): void;
	getScale(): number;
	getPan(): { x: number; y: number };
	fit(nodeIds?: string[], options?: { animated?: boolean }): void;
	setRenderer(renderer: string): void;
	destroy(): void;
}

/**
 * Structural slice of the renderer's ExternalCallbacks (constructor 5th arg)
 * this adapter rides. `onLayoutDone` is the renderer's own "layout is done
 * moving" signal — the real motion lever a naive polling approach would
 * miss; isLayoutMoving() is derived from it, never guessed from the layout
 * name.
 */
export interface NvlLikeCallbacks {
	onLayoutDone?: () => void;
	onLayoutStep?: (nodes: unknown[]) => void;
	onLayoutComputing?: (isComputing: boolean) => void;
}

export type NvlInstanceFactory = (
	container: unknown,
	nodes: BackendNode[],
	rels: BackendRel[],
	options: Record<string, unknown>,
	callbacks: NvlLikeCallbacks,
) => NvlLikeInstance;

const CSS_VAR_PATTERN = /^var\((--[\w-]+)(?:\s*,\s*(.+))?\)$/;

/**
 * Selection salience. The renderer's built-in per-element `selected` flag
 * only scales rel width ×1.5 (bundle: `Xs = (e.selected?1.5:1)·width`) with
 * NO colour change — imperceptible against the subdued base edge
 * (`rgba(148,163,184,0.35)`, ~1px). So the highlight ALSO lifts an
 * explicit salient colour + width on the flip-to-selected, and restores the
 * exact snapshotted base style on the flip-to-deselected — the subdued base
 * stays subdued. Theme-tokened with a concrete fallback so the canvas/WebGL
 * colour path (which can't parse CSS vars) always receives a real colour.
 */
const EDGE_SELECTED_COLOR =
	"var(--graphpane-edge-selected, rgba(174, 194, 248, 0.95))";
const EDGE_SELECTED_WIDTH = 2.5;

/**
 * Size normalization for dpr-independent world-space sizing (measured exact
 * at zoom 1 AND 2, canvas renderer):
 *
 *   position: css = (Z/dpr)·(world − pan) + cssSize/2
 *   radius:   css_radius = size · Z        (renderer `size` = RADIUS, no dpr division)
 *
 * Positions compress by 1/dpr but radii do NOT — so a raw lens size renders at
 * `size · dpr` WORLD radius (2× the intended diameter at dpr 1, 4× at dpr 2).
 * Handing the renderer `size/(2·dpr)` makes the engine's
 * size channel a true dpr-independent world-space DIAMETER: drawn world radius
 * = size/2, matching a consumer's precomputed overview radius and label
 * anchor radius (size/2) exactly. One-way boundary: getNodes()
 * returns renderer-space sizes — never feed a read-back node into ingest.
 */
function normalizedNodeSize(size: unknown, dpr: number): unknown {
	if (typeof size !== "number" || !Number.isFinite(size)) return size;
	return size / (2 * dpr);
}

function deviceDpr(): number {
	return (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1;
}

/**
 * Resolve `var(--token, fallback)` color strings against the live container
 * before they reach the renderer — canvas 2D fillStyle and the WebGL uniform
 * path both take concrete colors only, so an unresolved custom property
 * would otherwise silently render as the default. Non-var strings pass
 * through untouched; unresolvable vars fall to their declared fallback, else
 * stay unset.
 */
function resolveCssColor(container: unknown, value: unknown): unknown {
	if (typeof value !== "string") return value;
	const match = CSS_VAR_PATTERN.exec(value.trim());
	if (!match) return value;
	const [, name, fallback] = match;
	if (
		typeof window !== "undefined" &&
		container instanceof Element &&
		typeof window.getComputedStyle === "function"
	) {
		const resolved = window
			.getComputedStyle(container)
			.getPropertyValue(name)
			.trim();
		if (resolved) return resolved;
	}
	return fallback !== undefined ? fallback.trim() : undefined;
}

export class NvlBackend implements GraphBackend {
	readonly name = "nvl";
	private readonly instance: NvlLikeInstance;
	private readonly container: unknown;
	private selected = new Set<string>();
	private selectedRels = new Set<string>();
	/**
	 * Base (pre-selection) rel style, snapshotted at ingest so selection
	 * salience can be lifted and then restored exactly. Keyed by rel id;
	 * only base ingest writes it — selection flips bypass the snapshot path.
	 */
	private relBaseStyle = new Map<
		string,
		{ color?: unknown; width?: unknown }
	>();
	private layoutName: BackendConstructOptions["layout"];
	/** Sims are moving from construction until the renderer says done. */
	private layoutMoving: boolean;
	private lastPositionsSample: Record<string, { x: number; y: number }> | null =
		null;
	private stableSamples = 0;

	constructor(
		options: BackendConstructOptions,
		createInstance: NvlInstanceFactory,
	) {
		assertTelemetryDisabled(options);
		this.container = options.container;
		this.layoutName = options.layout;
		this.layoutMoving = options.layout !== "free";
		this.instance = createInstance(
			options.container,
			[],
			[],
			{
				renderer: options.renderer,
				layout: options.layout,
				disableTelemetry: true,
				...(options.minZoom !== undefined && { minZoom: options.minZoom }),
				...(options.maxZoom !== undefined && { maxZoom: options.maxZoom }),
				...(options.layoutTimeLimit !== undefined && {
					layoutTimeLimit: options.layoutTimeLimit,
				}),
				...(options.relationshipThreshold !== undefined && {
					relationshipThreshold: options.relationshipThreshold,
				}),
			},
			{
				onLayoutDone: () => {
					this.layoutMoving = false;
				},
				onLayoutStep: () => {
					this.layoutMoving = true;
				},
				onLayoutComputing: (isComputing) => {
					if (isComputing) this.layoutMoving = true;
				},
			},
		);
	}

	getNodes(): BackendNode[] {
		return this.instance
			.getNodes()
			.map((n) => ({ ...n, id: String(n.id) }) as BackendNode);
	}
	getRelationships(): BackendRel[] {
		return this.instance
			.getRelationships()
			.map((r) => ({ ...r, id: String(r.id) }) as unknown as BackendRel);
	}
	getNodeById(id: string): BackendNode | undefined {
		return this.getNodes().find((n) => n.id === id);
	}
	getNodePositions(): Record<string, { x: number; y: number }> {
		const out: Record<string, { x: number; y: number }> = {};
		for (const p of this.instance.getNodePositions?.() ?? []) {
			if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
			out[String(p.id)] = { x: p.x as number, y: p.y as number };
		}
		return out;
	}
	setNodePositions(
		positions: Array<{ id: string; x: number; y: number }>,
		animate = false,
	): void {
		this.instance.setNodePositions(positions, animate);
	}
	/** Pin ops — renderer-verified behavior: pinNode drives
	 *  nodes.update([{id, pinned:true}]) so a sim never yanks the node back.
	 *  Under `free` these are near-no-ops (positions are already authoritative);
	 *  guarded because the injected instance is a structural type. */
	pinNode(id: string): void {
		this.instance.pinNode?.(id);
	}
	unPinNode(id: string): void {
		this.instance.unPinNode?.([id]);
	}
	addAndUpdateElementsInGraph(nodes: BackendNode[], rels: BackendRel[]): void {
		// New data re-heats a client sim; `free` stays settled by definition.
		if (this.layoutName !== "free") {
			this.layoutMoving = true;
			this.lastPositionsSample = null;
			this.stableSamples = 0;
		}
		const resolvedRels = rels.map((r) => this.withResolvedColor(r));
		// Snapshot each rel's BASE style (post var-resolution) so selection
		// salience restores the subdued base exactly on deselect.
		// Selection flips bypass THIS method (they hit the instance directly),
		// so the snapshot only ever captures base ingest style, never salience.
		for (const r of resolvedRels) {
			const rec = r as Record<string, unknown>;
			if (rec.color !== undefined || rec.width !== undefined) {
				this.relBaseStyle.set(String(r.id), {
					color: rec.color,
					width: rec.width,
				});
			}
		}
		const dpr = deviceDpr();
		this.instance.addAndUpdateElementsInGraph(
			nodes.map((n) => this.withNormalizedSize(this.withResolvedColor(n), dpr)),
			resolvedRels,
		);
	}
	private withNormalizedSize<T extends { id: string }>(
		element: T,
		dpr: number,
	): T {
		const size = (element as Record<string, unknown>).size;
		const normalized = normalizedNodeSize(size, dpr);
		if (normalized === size) return element;
		return { ...element, size: normalized };
	}
	private withResolvedColor<T extends { id: string }>(element: T): T {
		const color = (element as Record<string, unknown>).color;
		if (color === undefined) return element;
		const resolved = resolveCssColor(this.container, color);
		if (resolved === color) return element;
		if (resolved === undefined) {
			const { color: _color, ...rest } = element as T & { color?: unknown };
			return rest as unknown as T;
		}
		return { ...element, color: resolved };
	}
	removeNodesWithIds(ids: string[]): void {
		this.instance.removeNodesWithIds(ids);
	}
	removeRelationshipsWithIds(ids: string[]): void {
		this.instance.removeRelationshipsWithIds(ids);
	}
	getSelectedNodeIds(): string[] {
		const native = this.instance.getSelectedNodes?.();
		if (native) return native.map((n) => String(n.id));
		return [...this.selected];
	}
	setSelectedNodeIds(ids: string[]): void {
		// Selection is the ONE authoritative highlight — it must actually
		// REACH the renderer. A Set-only implementation would leave every
		// tap invisible on canvas: the renderer draws its
		// selection ring from the per-element `selected` flag, so push the
		// delta (and only the delta) into the instance.
		const next = new Set(ids.map(String));
		const patches: Array<{ id: string; selected: boolean }> = [];
		for (const id of next) {
			if (!this.selected.has(id)) patches.push({ id, selected: true });
		}
		for (const id of this.selected) {
			if (!next.has(id)) patches.push({ id, selected: false });
		}
		this.selected = next;
		if (patches.length > 0) {
			this.instance.addAndUpdateElementsInGraph(patches, []);
		}
	}
	setSelectedRelIds(ids: string[]): void {
		// Incident/explicit edges ride the same delta-push path
		// as node selection (the renderer draws rel emphasis from the per-element
		// `selected` flag), AND carry explicit salience: the flip-to-selected
		// lifts a bright colour + boosted width (the built-in flag alone is
		// invisible on the subdued base), the flip-to-deselected restores the
		// snapshotted base. Only the flips are pushed.
		const next = new Set(ids.map(String));
		const patches: Array<Record<string, unknown>> = [];
		const salientColor = resolveCssColor(this.container, EDGE_SELECTED_COLOR);
		for (const id of next) {
			if (!this.selectedRels.has(id)) {
				patches.push({
					id,
					selected: true,
					...(salientColor !== undefined && { color: salientColor }),
					width: EDGE_SELECTED_WIDTH,
				});
			}
		}
		for (const id of this.selectedRels) {
			if (!next.has(id)) patches.push(this.deselectRelPatch(id));
		}
		this.selectedRels = next;
		if (patches.length > 0) {
			this.instance.addAndUpdateElementsInGraph([], patches);
		}
	}
	/**
	 * The deselect flip for one rel: clear the `selected` flag and restore the
	 * snapshotted base colour/width. Rels with no base snapshot (never ingested
	 * with a style — e.g. selection-only test rels) restore to just the flag,
	 * letting NVL fall back to its default rel style.
	 */
	private deselectRelPatch(id: string): Record<string, unknown> {
		const base = this.relBaseStyle.get(id);
		return {
			id,
			selected: false,
			...(base?.color !== undefined && { color: base.color }),
			...(base?.width !== undefined && { width: base.width }),
		};
	}
	deselectAll(): void {
		if (this.selected.size > 0) {
			this.instance.addAndUpdateElementsInGraph(
				[...this.selected].map((id) => ({ id, selected: false })),
				[],
			);
		}
		if (this.selectedRels.size > 0) {
			this.instance.addAndUpdateElementsInGraph(
				[],
				[...this.selectedRels].map((id) => this.deselectRelPatch(id)),
			);
		}
		this.selected.clear();
		this.selectedRels.clear();
		this.instance.deselectAll?.();
	}
	setZoomAndPan(zoom: number, panX: number, panY: number): void {
		this.instance.setZoomAndPan(zoom, panX, panY);
	}
	getScale(): number {
		return this.instance.getScale();
	}
	getPan(): { x: number; y: number } {
		return this.instance.getPan();
	}
	fit(nodeIds?: string[], animated = false): void {
		this.instance.fit(nodeIds, { animated });
	}
	setRenderer(renderer: "canvas" | "webgl"): void {
		this.instance.setRenderer(renderer);
	}
	isLayoutMoving(): boolean {
		// `free` settle is known at load (a naive `layout !== "free"` stub that
		// always returns true under a sim would mean settle could never be
		// observed). Sims settle by EITHER signal:
		//  - renderer onLayoutDone (fast path, when the renderer emits it), or
		//  - position quiescence: the renderer's bundled d3Force runs with
		//    alphaDecay 0 and onLayoutDone is not guaranteed to fire, so motion
		//    is judged from observed positions — settled
		//    after 10 consecutive stable samples (ε 0.01 world units,
		//    sub-pixel at max zoom; callers poll per rAF ⇒ ~160ms stable).
		// Sampling is O(N) per call, only while unsettled, on ≤2k-node sims
		// (the layout-policy ceiling) — it stops the moment settle is reached.
		if (this.layoutName === "free") return false;
		if (!this.layoutMoving) return false;
		const current = this.getNodePositions();
		const previous = this.lastPositionsSample;
		this.lastPositionsSample = current;
		if (!previous) return true;
		const keys = Object.keys(current);
		let moved = keys.length !== Object.keys(previous).length;
		if (!moved) {
			for (const key of keys) {
				const a = previous[key];
				const b = current[key];
				if (
					!a ||
					!b ||
					Math.abs(a.x - b.x) > 0.01 ||
					Math.abs(a.y - b.y) > 0.01
				) {
					moved = true;
					break;
				}
			}
		}
		if (moved) {
			this.stableSamples = 0;
			return true;
		}
		this.stableSamples += 1;
		if (this.stableSamples >= 10) {
			this.layoutMoving = false;
			return false;
		}
		return true;
	}
	destroy(): void {
		this.instance.destroy();
	}
}

export function createNvlBackendFactory(createInstance: NvlInstanceFactory) {
	return (options: BackendConstructOptions): GraphBackend =>
		new NvlBackend(options, createInstance);
}
