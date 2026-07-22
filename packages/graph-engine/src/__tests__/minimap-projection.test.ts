/**
 * Minimap projection, locked as tests.
 *
 * The minimap's world↔map math must be exact and involutive, and the
 * viewport rect must derive from the SAME center-origin transform the
 * renderer uses (view.ts seam) — a drifted rect is worse than none.
 */

import type { GraphNodeV1 } from "@fxyz/graph-contract";
import {
	clampToWorld,
	fitWorldToMap,
	MINIMAP_H,
	MINIMAP_W,
	mapToWorld,
	minimapRect,
	viewportWorldRect,
	worldBounds,
	worldToMap,
} from "../react/minimap";
import type { PaneView } from "../react/view";
import { screenToWorld } from "../react/view";

function node(id: string, x: number, y: number): GraphNodeV1 {
	return {
		id: `concept:${id}` as GraphNodeV1["id"],
		kind: "concept",
		label: id,
		labelQuality: "named",
		roles: ["topology"],
		provenance: "real",
		x,
		y,
	} as GraphNodeV1;
}

describe("minimap projection", () => {
	it("bounds ignore unpositioned nodes and need 2+ distinct points", () => {
		expect(worldBounds([node("a", 0, 0)])).toBeNull();
		expect(worldBounds([node("a", 5, 5), { ...node("b", 5, 5) }])).toBeNull(); // zero-area world → no map
		const b = worldBounds([
			node("a", -100, 40),
			node("b", 300, -60),
			{ ...node("c", Number.NaN, 10), x: undefined } as GraphNodeV1,
		]);
		expect(b).toEqual({ minX: -100, minY: -60, maxX: 300, maxY: 40 });
	});

	it("world→map→world is involutive and stays inside the padded map", () => {
		const bounds = { minX: -500, minY: -250, maxX: 1500, maxY: 750 };
		const p = fitWorldToMap(bounds);
		for (const [x, y] of [
			[-500, -250],
			[1500, 750],
			[123.5, -77.25],
		] as const) {
			const m = worldToMap(p, x, y);
			expect(m.x).toBeGreaterThanOrEqual(0);
			expect(m.x).toBeLessThanOrEqual(MINIMAP_W);
			expect(m.y).toBeGreaterThanOrEqual(0);
			expect(m.y).toBeLessThanOrEqual(MINIMAP_H);
			const w = mapToWorld(p, m.x, m.y);
			expect(w.x).toBeCloseTo(x, 6);
			expect(w.y).toBeCloseTo(y, 6);
		}
	});

	it("contain-fit preserves aspect (one axis fills, none overflows)", () => {
		const wide = fitWorldToMap({ minX: 0, minY: 0, maxX: 4000, maxY: 100 });
		const tall = fitWorldToMap({ minX: 0, minY: 0, maxX: 100, maxY: 4000 });
		// Wide world binds on X; tall world binds on Y — same m on both axes.
		const wideSpanX = worldToMap(wide, 4000, 0).x - worldToMap(wide, 0, 0).x;
		const tallSpanY = worldToMap(tall, 0, 4000).y - worldToMap(tall, 0, 0).y;
		expect(wideSpanX).toBeCloseTo(MINIMAP_W - 12, 6);
		expect(tallSpanY).toBeCloseTo(MINIMAP_H - 12, 6);
	});

	it("jump clamp: letterbox presses land on the world edge, never in the void", () => {
		const p = fitWorldToMap({ minX: -500, minY: -250, maxX: 1500, maxY: 750 });
		// A press at the map's extreme corner extrapolates past the world edge…
		const outside = mapToWorld(p, 0, MINIMAP_H);
		const clamped = clampToWorld(p, outside.x, outside.y);
		expect(clamped.x).toBeGreaterThanOrEqual(p.bounds.minX);
		expect(clamped.x).toBeLessThanOrEqual(p.bounds.maxX);
		expect(clamped.y).toBeGreaterThanOrEqual(p.bounds.minY);
		expect(clamped.y).toBeLessThanOrEqual(p.bounds.maxY);
		// …while in-world points pass through untouched.
		const inside = clampToWorld(p, 123.5, -77.25);
		expect(inside).toEqual({ x: 123.5, y: -77.25 });
	});

	it("drawn rect never goes sub-pixel at deep zoom — min 6×4, centered on the true rect", () => {
		// A large world (~18.8k×12.6k) at a deep zoom showing 100×75
		// world units: the true map rect is <1px on both axes.
		const p = fitWorldToMap({ minX: 0, minY: 0, maxX: 18000, maxY: 12000 });
		const view: PaneView = {
			scale: 8,
			panX: 9000,
			panY: 6000,
			width: 800,
			height: 600,
			dpr: 1,
		};
		const rect = minimapRect(p, view);
		expect(rect.w).toBeGreaterThanOrEqual(6);
		expect(rect.h).toBeGreaterThanOrEqual(4);
		const trueCenter = worldToMap(p, view.panX, view.panY);
		expect(rect.x + rect.w / 2).toBeCloseTo(trueCenter.x, 6);
		expect(rect.y + rect.h / 2).toBeCloseTo(trueCenter.y, 6);
	});

	it("drawn rect above the minimum is the raw projected rect (no distortion)", () => {
		const p = fitWorldToMap({ minX: -500, minY: -250, maxX: 1500, maxY: 750 });
		// Zoomed out enough that the viewport covers most of the world.
		const view: PaneView = {
			scale: 0.5,
			panX: 500,
			panY: 250,
			width: 800,
			height: 600,
			dpr: 1,
		};
		const world = viewportWorldRect(view);
		const a = worldToMap(p, world.x, world.y);
		const b = worldToMap(p, world.x + world.w, world.y + world.h);
		const rect = minimapRect(p, view);
		expect(rect.x).toBeCloseTo(Math.max(-1, a.x), 6);
		expect(rect.y).toBeCloseTo(Math.max(-1, a.y), 6);
		expect(rect.x + rect.w).toBeCloseTo(Math.min(MINIMAP_W + 1, b.x), 6);
		expect(rect.y + rect.h).toBeCloseTo(Math.min(MINIMAP_H + 1, b.y), 6);
	});

	it("viewport rect matches the renderer transform's visible corners", () => {
		const view: PaneView = {
			scale: 2,
			panX: 120,
			panY: -40,
			width: 800,
			height: 600,
			dpr: 2,
		};
		const rect = viewportWorldRect(view);
		const topLeft = screenToWorld(view, 0, 0);
		const bottomRight = screenToWorld(view, view.width, view.height);
		expect(rect.x).toBeCloseTo(topLeft.x, 6);
		expect(rect.y).toBeCloseTo(topLeft.y, 6);
		expect(rect.x + rect.w).toBeCloseTo(bottomRight.x, 6);
		expect(rect.y + rect.h).toBeCloseTo(bottomRight.y, 6);
	});
});
