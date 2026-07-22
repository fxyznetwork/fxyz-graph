/**
 * Minimap — the workbench navigability chrome an earlier legacy view had and
 * the engine pane lacked.
 *
 * Design: the node field is drawn ONCE per payload into an offscreen bitmap
 * (positions never move under `free` — server-position invariant), so the
 * per-frame cost during pan/zoom is one drawImage + one stroked rect. All
 * world↔map math is pure and exported for the test suite; the viewport rect
 * derives from the SAME center-origin transform the renderer uses (view.ts
 * seam).
 *
 * Interaction: press or drag jumps the camera (pan-only — zoom stays the
 * member's own gesture, same rule as the tap tween). Pointer events stop at
 * the minimap so the pane underneath never also pans.
 */

import type { GraphNodeV1 } from "@fxyz/graph-contract";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef } from "react";
import { cssScale, type PaneView } from "./view";

export const MINIMAP_W = 148;
export const MINIMAP_H = 92;
const MAP_PAD = 6;
const DOT_R = 1.25;

export interface WorldBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface MapProjection {
	/** map px per world unit. */
	m: number;
	/** map-space offsets that center the fitted world. */
	ox: number;
	oy: number;
	bounds: WorldBounds;
}

/** Bounds over finitely-positioned nodes; null below 2 points (no map). */
export function worldBounds(nodes: GraphNodeV1[]): WorldBounds | null {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let count = 0;
	for (const n of nodes) {
		const x = n.x as number;
		const y = n.y as number;
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		count += 1;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	if (count < 2 || maxX - minX <= 0 || maxY - minY <= 0) return null;
	return { minX, minY, maxX, maxY };
}

/** Contain-fit the world rect into the map rect, centered, padded. */
export function fitWorldToMap(
	bounds: WorldBounds,
	mapW = MINIMAP_W,
	mapH = MINIMAP_H,
	pad = MAP_PAD,
): MapProjection {
	const w = bounds.maxX - bounds.minX;
	const h = bounds.maxY - bounds.minY;
	const m = Math.min((mapW - 2 * pad) / w, (mapH - 2 * pad) / h);
	return {
		m,
		ox: (mapW - w * m) / 2,
		oy: (mapH - h * m) / 2,
		bounds,
	};
}

export function worldToMap(
	p: MapProjection,
	x: number,
	y: number,
): { x: number; y: number } {
	return {
		x: (x - p.bounds.minX) * p.m + p.ox,
		y: (y - p.bounds.minY) * p.m + p.oy,
	};
}

export function mapToWorld(
	p: MapProjection,
	x: number,
	y: number,
): { x: number; y: number } {
	return {
		x: (x - p.ox) / p.m + p.bounds.minX,
		y: (y - p.oy) / p.m + p.bounds.minY,
	};
}

/** Clamp a world point to the projection's bounds — a press in the
 *  letterboxed map margin could otherwise extrapolate PAST the world edge
 *  and land the camera in pure void. Jumps stop at the nearest world edge
 *  instead. */
export function clampToWorld(
	p: MapProjection,
	x: number,
	y: number,
): { x: number; y: number } {
	return {
		x: Math.min(p.bounds.maxX, Math.max(p.bounds.minX, x)),
		y: Math.min(p.bounds.maxY, Math.max(p.bounds.minY, y)),
	};
}

/** Minimum drawn viewport-rect size — at deep zoom on a large world the
 *  true rect goes sub-pixel and the location cue vanishes. */
const MIN_RECT_W = 6;
const MIN_RECT_H = 4;

/**
 * The viewport rect in MAP space as actually drawn: min-size enforced
 * (centered on the true rect) BEFORE the ±1px overdraw clip, so an
 * off-map rect is never pulled visible by the minimum.
 */
export function minimapRect(
	p: MapProjection,
	view: PaneView,
): { x: number; y: number; w: number; h: number } {
	const world = viewportWorldRect(view);
	const a = worldToMap(p, world.x, world.y);
	const b = worldToMap(p, world.x + world.w, world.y + world.h);
	let x0 = a.x;
	let y0 = a.y;
	let x1 = b.x;
	let y1 = b.y;
	if (x1 - x0 < MIN_RECT_W) {
		const c = (x0 + x1) / 2;
		x0 = c - MIN_RECT_W / 2;
		x1 = c + MIN_RECT_W / 2;
	}
	if (y1 - y0 < MIN_RECT_H) {
		const c = (y0 + y1) / 2;
		y0 = c - MIN_RECT_H / 2;
		y1 = c + MIN_RECT_H / 2;
	}
	const x = Math.max(-1, x0);
	const y = Math.max(-1, y0);
	return {
		x,
		y,
		w: Math.min(MINIMAP_W + 1, x1) - x,
		h: Math.min(MINIMAP_H + 1, y1) - y,
	};
}

/** The pane's visible world rect under the live transform (center-origin). */
export function viewportWorldRect(view: PaneView): {
	x: number;
	y: number;
	w: number;
	h: number;
} {
	const s = cssScale(view);
	const w = view.width / s;
	const h = view.height / s;
	return { x: view.panX - w / 2, y: view.panY - h / 2, w, h };
}

const containerStyle: CSSProperties = {
	position: "absolute",
	right: 10,
	bottom: 10,
	width: MINIMAP_W,
	height: MINIMAP_H,
	// Sharp corners (decision lock) · panel ground tuned for the dark theme
	// the graph surfaces commit to.
	background: "rgba(10, 10, 16, 0.78)",
	border: "1px solid rgba(255, 255, 255, 0.14)",
	cursor: "crosshair",
	touchAction: "none",
	zIndex: 3,
};

const DOT_COLOR = "rgba(251, 188, 122, 0.55)";
const RECT_STROKE = "rgba(174, 194, 248, 0.95)";
const RECT_FILL = "rgba(174, 194, 248, 0.10)";

export interface MinimapProps {
	/** ALL positioned nodes (never the label-budget subset). */
	nodes: GraphNodeV1[];
	view: PaneView;
	/** Center the camera at a world point (pan-only, immediate). */
	onJump: (worldX: number, worldY: number) => void;
}

export function Minimap({ nodes, view, onJump }: MinimapProps) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const draggingRef = useRef(false);

	const projection = useMemo(() => {
		const bounds = worldBounds(nodes);
		return bounds ? fitWorldToMap(bounds) : null;
	}, [nodes]);

	// The node field, rendered once per payload (positions are server truth
	// under `free`; a re-ingest replaces the nodes array identity).
	const bitmap = useMemo(() => {
		if (!projection || typeof document === "undefined") return null;
		const dpr =
			typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
		const off = document.createElement("canvas");
		off.width = MINIMAP_W * dpr;
		off.height = MINIMAP_H * dpr;
		const ctx = off.getContext("2d");
		if (!ctx) return null; // jsdom / headless: minimap degrades to nothing
		ctx.scale(dpr, dpr);
		ctx.fillStyle = DOT_COLOR;
		for (const n of nodes) {
			const x = n.x as number;
			const y = n.y as number;
			if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
			const p = worldToMap(projection, x, y);
			ctx.fillRect(p.x - DOT_R, p.y - DOT_R, DOT_R * 2, DOT_R * 2);
		}
		return off;
	}, [nodes, projection]);

	// Per-frame composite: blit the field, stroke the live viewport rect.
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !projection || !bitmap) return;
		const dpr =
			typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
		if (canvas.width !== MINIMAP_W * dpr) {
			canvas.width = MINIMAP_W * dpr;
			canvas.height = MINIMAP_H * dpr;
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
		ctx.drawImage(bitmap, 0, 0, MINIMAP_W, MINIMAP_H);
		if (view.width > 0 && view.height > 0) {
			const { x, y, w, h } = minimapRect(projection, view);
			ctx.fillStyle = RECT_FILL;
			ctx.fillRect(x, y, w, h);
			ctx.strokeStyle = RECT_STROKE;
			ctx.lineWidth = 1;
			ctx.strokeRect(x, y, w, h);
		}
	}, [bitmap, projection, view]);

	const jumpFromEvent = (e: ReactPointerEvent<HTMLCanvasElement>) => {
		if (!projection) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const world = mapToWorld(
			projection,
			e.clientX - rect.left,
			e.clientY - rect.top,
		);
		const clamped = clampToWorld(projection, world.x, world.y);
		onJump(clamped.x, clamped.y);
	};

	if (!projection) return null;

	return (
		<div style={containerStyle} data-graphpane-minimap>
			<canvas
				ref={canvasRef}
				style={{ width: "100%", height: "100%", display: "block" }}
				aria-label="Graph minimap"
				onPointerDown={(e) => {
					e.stopPropagation();
					e.currentTarget.setPointerCapture(e.pointerId);
					draggingRef.current = true;
					jumpFromEvent(e);
				}}
				onPointerMove={(e) => {
					e.stopPropagation();
					if (draggingRef.current) jumpFromEvent(e);
				}}
				onPointerUp={(e) => {
					e.stopPropagation();
					draggingRef.current = false;
				}}
				onPointerCancel={() => {
					draggingRef.current = false;
				}}
			/>
		</div>
	);
}
