/**
 * The headless controller.
 *
 * One backend instance per engine, constructed ONCE — a data change never
 * reconstructs it, a lens/filter change never reconstructs it, and the config
 * is frozen at construction. Ingest is contract-payloads-only with
 * defense-in-depth re-validation, positions flow id-keyed into the
 * PositionStore and the backend under `free`, and the camera fits exactly once
 * on first data-ready.
 */

import {
	DEFAULT_TIER_BUDGETS,
	type GraphPayloadV1,
	type GraphRef,
	MEASURE_KINDS,
	type PositionMap,
	type StyleRule,
	TIERS,
	type TierBudgets,
} from "@fxyz/graph-contract";
import type {
	BackendConstructOptions,
	BackendFactory,
	BackendNode,
	BackendRel,
	GraphBackend,
} from "../backend/contract";
import { PositionStore, SelectionStore } from "../identity/stores";
import {
	DEFAULT_LAYOUT_POLICY,
	type LayoutPolicy,
	resolveLayout,
} from "../layout/policy";
import {
	applyStyleRules,
	diffStylePatches,
	type StylePatch,
} from "../lens/apply";
import { applyDataUpdate } from "./diff";

const MEASURE_SET: ReadonlySet<string> = new Set(MEASURE_KINDS);
const TIER_SET: ReadonlySet<string> = new Set(TIERS);

/**
 * Deterministic-fit tuning (fitServerPositions): css padding reserves room
 * for disc radii + the label overlay; the scale caps keep degenerate payloads
 * (single node / near-coincident positions) from zooming to absurdity.
 */
const FIT_PADDING_CSS = 56;
const MIN_FIT_CSS_SCALE = 0.02;
const MAX_FIT_CSS_SCALE = 1.5;
const DID_PATTERN = /\bdid:[a-z0-9]+:/i;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

export class EngineViolation extends Error {
	readonly rule: string;
	constructor(rule: string, message: string) {
		super(`[${rule}] ${message}`);
		this.name = "EngineViolation";
		this.rule = rule;
	}
}

export interface EngineDeps {
	layoutPolicy?: LayoutPolicy;
	budgets?: TierBudgets;
}

export type EnginePhase = "constructing" | "ready" | "destroyed";

export class GraphEngine {
	readonly backend: GraphBackend;
	readonly options: Readonly<BackendConstructOptions>;
	readonly positions = new PositionStore();
	readonly selection = new SelectionStore();
	private readonly layoutPolicy: LayoutPolicy;
	private readonly budgets: TierBudgets;
	private phase: EnginePhase = "constructing";
	private fittedOnce = false;
	private ingestCount = 0;
	private lastPatches = new Map<GraphRef, StylePatch>();
	private lastPayloadNodes = new Map<
		GraphRef,
		GraphPayloadV1["nodes"][number]
	>();
	/** ref → incident edge ids — rebuilt per ingest with the node map. */
	private incidentEdges = new Map<GraphRef, string[]>();
	/**
	 * Session-local drag overrides (id-keyed): ref → world
	 * position a member dragged the node to. Server positions stay the truth —
	 * overrides are re-applied AFTER every ingest (so a pin survives lens
	 * flips and data refreshes) and are never written back to the server.
	 */
	private positionOverrides = new Map<GraphRef, { x: number; y: number }>();

	constructor(
		factory: BackendFactory,
		options: BackendConstructOptions,
		deps: EngineDeps = {},
	) {
		// Stable config identity: the options object is frozen; a mid-life
		// mutation (the per-render reinit trigger class) throws.
		this.options = Object.freeze({ ...options });
		this.layoutPolicy = deps.layoutPolicy ?? DEFAULT_LAYOUT_POLICY;
		this.budgets = deps.budgets ?? DEFAULT_TIER_BUDGETS;
		this.backend = factory(this.options);
		this.phase = "ready";
	}

	get status(): EnginePhase {
		return this.phase;
	}
	get ingests(): number {
		return this.ingestCount;
	}

	/**
	 * Contract payloads only, incremental always. Throws EngineViolation on
	 * rule breaches — the engine never silently slices, scatters, or sanitizes.
	 */
	ingest(payload: GraphPayloadV1): void {
		if (this.phase === "destroyed") {
			throw new EngineViolation("lifecycle", "ingest after destroy");
		}
		// Versioned payload contract.
		if (payload.version !== 1) {
			throw new EngineViolation(
				"contract",
				`unknown payload version '${String(payload.version)}'`,
			);
		}
		if (!TIER_SET.has(payload.tier)) {
			throw new EngineViolation("contract", `unknown tier '${payload.tier}'`);
		}
		// Budgets are enforced server-side; an over-budget payload is a server
		// bug surfaced LOUD, never a silent client slice.
		const budget = this.budgets[payload.tier].maxNodes.value;
		if (payload.nodes.length > budget) {
			throw new EngineViolation(
				"budget",
				`payload of ${payload.nodes.length} nodes exceeds the '${payload.tier}' budget (${budget}) — cap server-side; a client-side slice firing is a failure, not a safety net`,
			);
		}
		// Layout policy consistency.
		const resolved = resolveLayout(this.layoutPolicy, payload);
		if (resolved === "free" && this.options.layout !== "free") {
			throw new EngineViolation(
				"positions",
				"payload carries server positions but the backend was constructed with a client sim — construct with layout:'free'",
			);
		}
		// Defense in depth behind the serializer choke point.
		for (const node of payload.nodes) {
			if (DID_PATTERN.test(node.label) || EMAIL_PATTERN.test(node.label)) {
				throw new EngineViolation(
					"pii",
					`sensitive-data pattern in label of '${node.id}' — upstream serializer bypassed?`,
				);
			}
			if (node.measures) {
				for (const key of Object.keys(node.measures)) {
					if (!MEASURE_SET.has(key)) {
						throw new EngineViolation(
							"confidential",
							`unknown measure '${key}' on '${node.id}'`,
						);
					}
				}
			}
		}

		// Map contract → backend shapes (GraphRef strings ARE the backend ids).
		// `label`, NOT `caption`: labels are OUR budgeted overlay — a caption key
		// would trigger a renderer's own caption path and give two competing
		// label systems.
		const backendNodes: BackendNode[] = payload.nodes.map((n) => ({
			id: n.id,
			...(n.x !== undefined && { x: n.x }),
			...(n.y !== undefined && { y: n.y }),
			label: n.label,
			kind: n.kind,
			provenance: n.provenance,
		}));
		// Edges recede, nodes speak: subdued themeable color (resolved at the
		// backend boundary) + weight-scaled width, so a dense summary tier reads
		// as structure instead of arrowhead spaghetti.
		let maxWeight = 0;
		for (const e of payload.edges) {
			if (typeof e.weight === "number" && e.weight > maxWeight) {
				maxWeight = e.weight;
			}
		}
		const backendRels: BackendRel[] = payload.edges.map((e) => ({
			id: e.id,
			from: e.source,
			to: e.target,
			type: e.type,
			provenance: e.provenance,
			color: "var(--graphpane-edge, rgba(148, 163, 184, 0.35))",
			width:
				typeof e.weight === "number" && maxWeight > 0
					? 0.6 + 1.8 * Math.sqrt(Math.max(0, e.weight) / maxWeight)
					: 1,
		}));

		// Incremental only: remove-then-upsert.
		applyDataUpdate(this.backend, backendNodes, backendRels);

		// Id-keyed positions join across tiers/fetches by ref.
		if (payload.positionsIncluded) {
			const positions: PositionMap = {};
			for (const n of payload.nodes) {
				positions[n.id] = { x: n.x as number, y: n.y as number };
			}
			this.positions.setMany(positions);
			this.backend.setNodePositions(
				payload.nodes.map((n) => ({
					id: n.id,
					x: n.x as number,
					y: n.y as number,
				})),
				false,
			);
		}

		this.lastPayloadNodes = new Map(payload.nodes.map((n) => [n.id, n]));
		this.incidentEdges = new Map();
		for (const e of payload.edges) {
			for (const ref of [e.source, e.target]) {
				const bucket = this.incidentEdges.get(ref);
				if (bucket) bucket.push(e.id);
				else this.incidentEdges.set(ref, [e.id]);
			}
		}

		// Member drag overrides outrank the server push above: a re-ingest
		// (data refresh, expand) must not snap a pinned node back. Overrides for
		// refs absent from this payload stay parked — the ref may return with the
		// next fetch. Sim layouts rely on the backend's pinned flag instead (kept
		// nodes survive the incremental diff un-removed).
		if (payload.positionsIncluded && this.positionOverrides.size > 0) {
			const kept: Array<{ id: GraphRef; x: number; y: number }> = [];
			for (const [ref, pos] of this.positionOverrides) {
				if (!this.lastPayloadNodes.has(ref)) continue;
				kept.push({ id: ref, x: pos.x, y: pos.y });
			}
			if (kept.length > 0) {
				const positions: PositionMap = {};
				for (const p of kept) positions[p.id] = { x: p.x, y: p.y };
				this.positions.setMany(positions);
				this.backend.setNodePositions(kept, false);
			}
		}
		this.ingestCount += 1;

		// ONE fit on first data-ready; never a refit scheduler. Server-positioned
		// payloads fit deterministically through the verified transform model; the
		// backend's own fit stays only for sims, where world positions don't exist
		// yet at ingest.
		if (!this.fittedOnce && payload.nodes.length > 0) {
			const fitted =
				payload.positionsIncluded === true && this.fitServerPositions(payload);
			if (!fitted) this.backend.fit(undefined, false);
			this.fittedOnce = true;
		}
	}

	/**
	 * Deterministic dpr-honest fit for server-positioned payloads. A backend's
	 * own fit() can under-zoom ~2× on dpr-2 displays, so when world positions
	 * are known the camera is computed from the pane's verified transform model
	 * instead:
	 *   css = (zoom/dpr)·(world − pan) + cssSize/2
	 * ⇒ zoom = cssScale·dpr with cssScale filling the container minus label
	 * padding, pan = world bbox center. Falls back to the backend fit when the
	 * container is unmeasurable (headless engines, jsdom without layout).
	 */
	private fitServerPositions(payload: GraphPayloadV1): boolean {
		// Duck-typed container measurement — the headless core stays DOM-free
		// (contract: container is `unknown`); real mounts pass an HTMLElement.
		const el = this.options.container as
			| { clientWidth?: unknown; clientHeight?: unknown }
			| null
			| undefined;
		const cssW = typeof el?.clientWidth === "number" ? el.clientWidth : 0;
		const cssH = typeof el?.clientHeight === "number" ? el.clientHeight : 0;
		if (!(cssW > 0) || !(cssH > 0)) return false;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let positioned = 0;
		for (const n of payload.nodes) {
			if (
				typeof n.x !== "number" ||
				typeof n.y !== "number" ||
				!Number.isFinite(n.x) ||
				!Number.isFinite(n.y)
			) {
				continue;
			}
			positioned += 1;
			if (n.x < minX) minX = n.x;
			if (n.x > maxX) maxX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.y > maxY) maxY = n.y;
		}
		if (positioned === 0) return false;
		const extentW = Math.max(maxX - minX, 1);
		const extentH = Math.max(maxY - minY, 1);
		// Tiny panes keep at least half their size usable — padding never
		// swallows the viewport.
		const availW = Math.max(cssW - 2 * FIT_PADDING_CSS, cssW * 0.5);
		const availH = Math.max(cssH - 2 * FIT_PADDING_CSS, cssH * 0.5);
		const cssScale = Math.min(
			MAX_FIT_CSS_SCALE,
			Math.max(MIN_FIT_CSS_SCALE, Math.min(availW / extentW, availH / extentH)),
		);
		const dpr =
			(globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1;
		this.backend.setZoomAndPan(
			cssScale * dpr,
			(minX + maxX) / 2,
			(minY + maxY) / 2,
		);
		return true;
	}

	/**
	 * Lens/filter deltas are INCREMENTAL: compute patches, diff against the
	 * previous patch map, re-push only the changed refs. Never reconstructs the
	 * backend, never re-pushes the full set.
	 */
	applyLens(rules: StyleRule[]): GraphRef[] {
		const nodes = [...this.lastPayloadNodes.values()];
		const next = applyStyleRules(nodes, rules);
		const changed = diffStylePatches(this.lastPatches, next);
		if (changed.length > 0) {
			const changedNodes: BackendNode[] = [];
			for (const ref of changed) {
				const node = this.lastPayloadNodes.get(ref);
				const patch = next.get(ref);
				if (!node || !patch) continue;
				changedNodes.push({
					id: ref,
					label: node.label,
					...patch,
				});
			}
			if (changedNodes.length > 0) {
				this.backend.addAndUpdateElementsInGraph(changedNodes, []);
			}
		}
		this.lastPatches = next;
		return changed;
	}

	select(refs: GraphRef[]): void {
		this.selection.select(refs);
		this.backend.setSelectedNodeIds(refs);
		// The neighborhood lights with the ring: incident edges of the selected
		// refs ride the selection push (still the ONE highlight — no hover, no
		// bespoke pulse).
		const incident = new Set<string>();
		for (const ref of refs) {
			const edges = this.incidentEdges.get(ref);
			if (edges) {
				for (const id of edges) incident.add(id);
			}
		}
		this.backend.setSelectedRelIds([...incident]);
	}

	/**
	 * Explicit edge-set selection (e.g. a routing path), independent of
	 * node-incident selection: lights EXACTLY these edge ids through the same
	 * highlight + salience channel (backend.setSelectedRelIds), leaving
	 * node selection untouched. setSelectedRelIds is a full-set replace, so each
	 * call replaces the previous explicit edge set (delta-pushed, never a
	 * reconstruction). deselectAll() clears it.
	 */
	selectEdges(edgeIds: string[]): void {
		this.backend.setSelectedRelIds(edgeIds);
	}

	/** Clears every highlight — node selection AND edge salience. */
	deselectAll(): void {
		this.selection.clear();
		this.backend.deselectAll();
	}

	/**
	 * Member drag: move a node to a session-local world position and pin it
	 * there. Never reconstructs, never writes back to the server — the override
	 * lives in this engine instance only.
	 */
	overrideNodePosition(ref: GraphRef, x: number, y: number): void {
		if (this.phase === "destroyed") {
			throw new EngineViolation("lifecycle", "position override after destroy");
		}
		if (!Number.isFinite(x) || !Number.isFinite(y)) return;
		this.positionOverrides.set(ref, { x, y });
		this.positions.setMany({ [ref]: { x, y } });
		this.backend.pinNode?.(ref);
		this.backend.setNodePositions([{ id: ref, x, y }], false);
	}

	/** Refs currently under a member drag override (read-only copy). */
	overriddenPositions(): PositionMap {
		const out: PositionMap = {};
		for (const [ref, pos] of this.positionOverrides) {
			out[ref] = { x: pos.x, y: pos.y };
		}
		return out;
	}

	/**
	 * Release every pin and restore the server truth where the current
	 * payload knows it (a ref with no server position simply unpins).
	 */
	clearPositionOverrides(): void {
		const restore: Array<{ id: GraphRef; x: number; y: number }> = [];
		const positions: PositionMap = {};
		for (const [ref] of this.positionOverrides) {
			this.backend.unPinNode?.(ref);
			const server = this.lastPayloadNodes.get(ref);
			if (
				server &&
				typeof server.x === "number" &&
				typeof server.y === "number" &&
				Number.isFinite(server.x) &&
				Number.isFinite(server.y)
			) {
				restore.push({ id: ref, x: server.x, y: server.y });
				positions[ref] = { x: server.x, y: server.y };
			}
		}
		this.positionOverrides.clear();
		if (restore.length > 0) {
			this.positions.setMany(positions);
			this.backend.setNodePositions(restore, false);
		}
	}

	destroy(): void {
		this.backend.destroy();
		this.phase = "destroyed";
	}
}
