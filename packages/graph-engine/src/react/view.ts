/**
 * Pane view math — pure, renderer-independent. ONE seam by design: every
 * world↔screen conversion goes through these functions.
 *
 * Transform model matches the underlying renderer's actual math:
 *
 *   backing_x = zoom · (world_x − panX) + canvasWidth/2,  canvas = css·dpr
 *   ⇒ css_x   = (zoom/dpr) · (world_x − panX) + cssWidth/2
 *
 * getScale() returns the backing zoom; getPan() returns {panX, panY} in
 * world units; the transform is CENTER-ORIGIN and pan is SUBTRACTIVE.
 * Live-verified (labels sit under their nodes).
 */

import type { GraphEdgeV1, GraphNodeV1 } from "@fxyz/graph-contract";
import {
	pointSegmentDistance2,
	SegmentGrid,
	SpatialGrid,
} from "../interaction/hit-index";

export interface PaneView {
	/** Backing zoom (backing px per layout px) — the renderer's getScale(). */
	scale: number;
	/** World-units pan — the renderer's getPan(). */
	panX: number;
	panY: number;
	/** Container CSS size (the transform is center-origin). */
	width: number;
	height: number;
	/** Device pixel ratio (css scale = zoom/dpr). */
	dpr: number;
}

/** css px per world unit. */
export function cssScale(view: PaneView): number {
	return view.scale / (view.dpr || 1);
}

export function worldToScreen(
	view: PaneView,
	x: number,
	y: number,
): { x: number; y: number } {
	const s = cssScale(view);
	return {
		x: s * (x - view.panX) + view.width / 2,
		y: s * (y - view.panY) + view.height / 2,
	};
}

export function screenToWorld(
	view: PaneView,
	x: number,
	y: number,
): { x: number; y: number } {
	const s = cssScale(view);
	return {
		x: (x - view.width / 2) / s + view.panX,
		y: (y - view.height / 2) / s + view.panY,
	};
}

/**
 * Zoom around a screen-space anchor (cursor / pinch centroid): the world
 * point under the anchor stays under it. Returns the next {scale, panX,
 * panY} (width/height/dpr are carried unchanged).
 */
export function zoomAround(
	view: PaneView,
	anchorX: number,
	anchorY: number,
	factor: number,
	minZoom = 0.05,
	maxZoom = 8,
): PaneView {
	const world = screenToWorld(view, anchorX, anchorY);
	const scale = Math.min(maxZoom, Math.max(minZoom, view.scale * factor));
	const s = scale / (view.dpr || 1);
	return {
		...view,
		scale,
		panX: world.x - (anchorX - view.width / 2) / s,
		panY: world.y - (anchorY - view.height / 2) / s,
	};
}

/**
 * Pan by a screen-space drag delta: the graph follows the pointer, so pan
 * moves OPPOSITE the world offset (pan is subtractive in the transform).
 */
export function panByScreenDelta(
	view: PaneView,
	dxCss: number,
	dyCss: number,
): PaneView {
	const s = cssScale(view);
	return {
		...view,
		panX: view.panX - dxCss / s,
		panY: view.panY - dyCss / s,
	};
}

/**
 * Overlay live backend positions onto contract nodes (id-keyed) — the ONE
 * join the hit index and the label overlay both read, so tap-testing and
 * labels use the SAME position source the renderer draws from. Nodes the
 * backend doesn't know keep their payload coordinates (or stay unpositioned
 * and are skipped by both consumers).
 */
export function mergeLivePositions(
	nodes: GraphNodeV1[],
	live: Record<string, { x: number; y: number }>,
): GraphNodeV1[] {
	let hasAny = false;
	for (const _ in live) {
		hasAny = true;
		break;
	}
	if (!hasAny) return nodes;
	return nodes.map((n) => {
		const p = live[n.id];
		return p ? { ...n, x: p.x, y: p.y } : n;
	});
}

/**
 * Tap-time hit-testing (bounded by local density, never a linear scan per
 * pointermove; hover is banned so this runs on TAPS only).
 */
export class NodeHitIndex {
	private readonly grid: SpatialGrid;
	private readonly byId: Map<string, GraphNodeV1>;

	constructor(nodes: GraphNodeV1[]) {
		this.byId = new Map(nodes.map((n) => [n.id, n]));
		this.grid = new SpatialGrid(
			nodes
				.filter(
					(n) =>
						Number.isFinite(n.x as number) && Number.isFinite(n.y as number),
				)
				.map((n) => ({ id: n.id, x: n.x as number, y: n.y as number })),
		);
	}

	get size(): number {
		return this.grid.size;
	}

	/**
	 * Nearest node within `screenRadius` css px of a screen point, or null.
	 * Positions may drift under a client sim — callers refresh the index from
	 * live backend positions before trusting it there (free/server layouts
	 * never drift).
	 */
	hit(
		view: PaneView,
		screenX: number,
		screenY: number,
		screenRadius = 24,
	): GraphNodeV1 | null {
		const world = screenToWorld(view, screenX, screenY);
		const radius = screenRadius / cssScale(view);
		const candidates = this.grid.query(world.x, world.y, radius);
		let best: { id: string; d2: number } | null = null;
		for (const c of candidates) {
			const dx = c.x - world.x;
			const dy = c.y - world.y;
			const d2 = dx * dx + dy * dy;
			if (!best || d2 < best.d2) best = { id: c.id, d2 };
		}
		return best ? (this.byId.get(best.id) ?? null) : null;
	}
}

/**
 * Tap-time EDGE hit-testing (corridors/routes were previously uninspectable).
 * Same rules as NodeHitIndex: spatial-grid bounded, taps only, consumer-gated
 * construction (the pane builds it lazily and only when an edge-inspect
 * consumer is wired). Node hits take precedence in the pane — an edge is
 * only offered when no node is under the tap.
 */
export class EdgeHitIndex {
	private readonly grid: SegmentGrid;
	private readonly byId: Map<string, GraphEdgeV1>;
	private readonly segById: Map<
		string,
		{ x1: number; y1: number; x2: number; y2: number }
	>;

	constructor(edges: GraphEdgeV1[], nodes: GraphNodeV1[]) {
		const pos = new Map<string, { x: number; y: number }>();
		for (const n of nodes) {
			if (Number.isFinite(n.x as number) && Number.isFinite(n.y as number)) {
				pos.set(n.id, { x: n.x as number, y: n.y as number });
			}
		}
		this.byId = new Map();
		this.segById = new Map();
		const segments = [];
		for (const e of edges) {
			const a = pos.get(e.source);
			const b = pos.get(e.target);
			if (!a || !b) continue; // unpositioned endpoint → untappable, honest
			this.byId.set(e.id, e);
			const seg = { id: e.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
			this.segById.set(e.id, seg);
			segments.push(seg);
		}
		this.grid = new SegmentGrid(segments);
	}

	get size(): number {
		return this.grid.size;
	}

	/** Nearest edge within `screenRadius` css px, or null. */
	hit(
		view: PaneView,
		screenX: number,
		screenY: number,
		screenRadius = 12,
	): GraphEdgeV1 | null {
		const world = screenToWorld(view, screenX, screenY);
		const radius = screenRadius / cssScale(view);
		const candidates = this.grid.query(world.x, world.y, radius);
		let best: { id: string; d2: number } | null = null;
		for (const c of candidates) {
			const seg = this.segById.get(c.id);
			if (!seg) continue;
			const d2 = pointSegmentDistance2(world.x, world.y, {
				id: c.id,
				...seg,
			});
			if (!best || d2 < best.d2) best = { id: c.id, d2 };
		}
		return best ? (this.byId.get(best.id) ?? null) : null;
	}
}
