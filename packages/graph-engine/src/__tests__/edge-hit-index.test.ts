/**
 * Edge hit-testing laws (Train 17 — gap audit 2026-07-21 #1: corridors and
 * route legs were uninspectable; an unindexed fallback would reintroduce
 * RC4's linear scan).
 */

import type { GraphEdgeV1, GraphNodeV1 } from "@fxyz/graph-contract";
import {
	type IndexedSegment,
	pointSegmentDistance2,
	SegmentGrid,
} from "../interaction/hit-index";
import { EdgeHitIndex, type PaneView } from "../react/view";

function node(id: string, x: number, y: number): GraphNodeV1 {
	return {
		id: `currency:${id}` as GraphNodeV1["id"],
		kind: "currency",
		label: id,
		labelQuality: "named",
		roles: ["money"],
		provenance: "real",
		x,
		y,
	} as GraphNodeV1;
}

function edge(id: string, source: string, target: string): GraphEdgeV1 {
	return {
		id,
		source: `currency:${source}` as GraphEdgeV1["source"],
		target: `currency:${target}` as GraphEdgeV1["target"],
		type: "CORRELATED",
		provenance: "real",
	} as GraphEdgeV1;
}

const seg = (
	id: string,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): IndexedSegment => ({ id, x1, y1, x2, y2 });

describe("pointSegmentDistance2", () => {
	it("projects to the interior and clamps to endpoints", () => {
		const s = seg("s", 0, 0, 100, 0);
		expect(pointSegmentDistance2(50, 5, s)).toBeCloseTo(25, 6);
		expect(pointSegmentDistance2(-30, 40, s)).toBeCloseTo(2500, 6); // clamp A
		expect(pointSegmentDistance2(130, 40, s)).toBeCloseTo(2500, 6); // clamp B
		// Degenerate zero-length segment = point distance.
		expect(pointSegmentDistance2(3, 4, seg("p", 0, 0, 0, 0))).toBeCloseTo(
			25,
			6,
		);
	});
});

describe("SegmentGrid", () => {
	it("finds a long diagonal from a mid-span query cell (law 10 bound)", () => {
		const diagonal = seg("d", 0, 0, 1000, 1000);
		const grid = new SegmentGrid([diagonal]);
		expect(grid.size).toBe(1);
		// Mid-span, 8 units off the line — far from both endpoints.
		expect(grid.query(500, 508, 16).map((s) => s.id)).toEqual(["d"]);
		// Far from the line: nothing.
		expect(grid.query(500, 700, 16)).toEqual([]);
	});

	it("dedupes a segment registered in many cells", () => {
		const grid = new SegmentGrid([seg("d", 0, 0, 1000, 0)]);
		// Query radius spanning several cells the same segment occupies.
		expect(grid.query(500, 0, 100)).toHaveLength(1);
	});

	it("skips non-finite endpoints", () => {
		const grid = new SegmentGrid([seg("bad", Number.NaN, 0, 100, 0)]);
		expect(grid.size).toBe(0);
	});
});

describe("EdgeHitIndex", () => {
	const nodes = [
		node("EUR", 0, 0),
		node("USD", 400, 0),
		node("JPY", 0, 300),
		node("GBP", Number.NaN, Number.NaN), // unpositioned
	];
	const edges = [
		edge("e1", "EUR", "USD"),
		edge("e2", "EUR", "JPY"),
		edge("e3", "EUR", "GBP"), // one endpoint unpositioned → untappable
	];
	// Identity-ish view: scale 1, dpr 1, centered at world origin.
	const view: PaneView = {
		scale: 1,
		panX: 0,
		panY: 0,
		width: 1000,
		height: 800,
		dpr: 1,
	};

	it("hits the nearest edge in screen space; nodes' own radius excluded by pane order", () => {
		const idx = new EdgeHitIndex(edges, nodes);
		expect(idx.size).toBe(2); // e3 dropped, honestly
		// Screen point over the EUR→USD span (world 200,4 → screen 700,404).
		const hit = idx.hit(view, 700, 404);
		expect(hit?.id).toBe("e1");
		// Screen point over the EUR→JPY span (world 2,150 → screen 502,550).
		expect(idx.hit(view, 502, 550)?.id).toBe("e2");
		// Far from every edge: null.
		expect(idx.hit(view, 900, 700)).toBeNull();
	});

	it("respects the css screen radius under dpr + zoom", () => {
		const idx = new EdgeHitIndex(edges, nodes);
		const zoomed: PaneView = { ...view, scale: 4, dpr: 2 }; // cssScale 2
		// World (200, 8) → screen (500 + 200·2, 400 + 8·2) = (900, 416).
		// 8 world units off the line = 16 css px — outside the default 12px
		// radius, inside 24.
		expect(idx.hit(zoomed, 900, 416, 12)).toBeNull();
		expect(idx.hit(zoomed, 900, 416, 24)?.id).toBe("e1");
	});
});
