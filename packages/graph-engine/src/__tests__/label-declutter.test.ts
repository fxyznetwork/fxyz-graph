/**
 * Label declutter behavior, addressing an overview that reads as "text
 * soup" when labels crowd together. Pure-machine tests over the exported
 * cull geometry: near-touching labels must COLLIDE (the cull margin is the
 * fix), distant labels must not, and the greedy order means the more
 * salient label survives.
 */

import {
	clampLabelX,
	labelRect,
	overlaps,
	type PlacedLabel,
} from "../react/label-overlay";

function placed(x: number, y: number, label = "United States of America · bank"): PlacedLabel {
	return {
		node: { id: `currency:${label}-${x}-${y}`, kind: "currency", label } as PlacedLabel["node"],
		x,
		y,
		fontSize: 12,
		opacity: 0.95,
	};
}

describe("label cull geometry (text-soup fix)", () => {
	it("two long labels stacked 20px apart collide — tight glyph boxes let them pile", () => {
		const a = placed(400, 300);
		const b = placed(400, 320);
		expect(overlaps(labelRect(a), labelRect(b))).toBe(true);
	});

	it("labels with real breathing room do not collide", () => {
		const a = placed(400, 300);
		const b = placed(400, 348); // 15.6px glyph box + 2×8 margin < 48
		expect(overlaps(labelRect(a), labelRect(b))).toBe(false);
	});

	it("side-by-side labels need horizontal clearance beyond the glyph edge", () => {
		const a = placed(400, 300);
		// 31-char label ≈ 230.6px wide → margin-inflated reach ≈ 127.3px each,
		// so centers < ~254.6px apart collide and centers past it clear.
		const touching = placed(400 + 250, 300);
		const clear = placed(400 + 290, 300);
		expect(overlaps(labelRect(a), labelRect(touching))).toBe(true);
		expect(overlaps(labelRect(a), labelRect(clear))).toBe(false);
	});

	it("short labels claim proportionally less space", () => {
		const a = placed(400, 300, "USD");
		const b = placed(460, 300, "EUR");
		expect(overlaps(labelRect(a), labelRect(b))).toBe(false);
	});
});

describe("label viewport clamp (mobile amputation fix)", () => {
	it("slides an edge-adjacent long label inward on a 375px pane", () => {
		// 31 chars @12px → half ≈ 115.3; center at -1 must clamp to 8 + half.
		const x = clampLabelX(-1, 31, 12, 375);
		expect(x).toBeCloseTo(8 + Math.min(240, 31 * 12 * 0.62) / 2, 1);
		expect(x).toBeGreaterThan(100);
	});

	it("clamps the right edge symmetrically", () => {
		const half = Math.min(240, 31 * 12 * 0.62) / 2;
		expect(clampLabelX(380, 31, 12, 375)).toBeCloseTo(375 - 8 - half, 1);
	});

	it("leaves centered labels untouched", () => {
		expect(clampLabelX(187, 31, 12, 375)).toBe(187);
	});

	it("keeps the anchor center when the pane is narrower than the label", () => {
		expect(clampLabelX(50, 40, 12, 200)).toBe(50);
	});
});
