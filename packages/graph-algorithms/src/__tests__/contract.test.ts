import { defaultChannelFor, encodeResult, normalize } from "../contract";
import type { AlgoResult } from "../types";

describe("encoding bridge (contract)", () => {
	it("encodes scores onto brightness, min-max normalized, raw value preserved", () => {
		const result: AlgoResult = {
			kind: "scores",
			values: new Map([
				["a", 2],
				["b", 4],
				["c", 6],
			]),
		};
		const enc = encodeResult(result);
		expect(enc.channel).toBe("brightness");
		expect(enc.nodes.get("a")?.brightness).toBeCloseTo(0);
		expect(enc.nodes.get("b")?.brightness).toBeCloseTo(0.5);
		expect(enc.nodes.get("c")?.brightness).toBeCloseTo(1);
		expect(enc.nodes.get("a")?.rawValue).toBe(2);
	});

	it("routes scores to the size channel when asked", () => {
		const result: AlgoResult = {
			kind: "scores",
			values: new Map([["a", 1]]),
		};
		const enc = encodeResult(result, { channel: "size" });
		expect(enc.channel).toBe("size");
		expect(enc.nodes.get("a")?.size).toBeDefined();
		expect(enc.nodes.get("a")?.brightness).toBeUndefined();
	});

	it("encodes communities onto categorical colour", () => {
		const result: AlgoResult = {
			kind: "communities",
			values: new Map([
				["a", 0],
				["b", 1],
			]),
		};
		const enc = encodeResult(result);
		expect(enc.channel).toBe("color-categorical");
		expect(enc.nodes.get("a")?.communityId).toBe(0);
		expect(enc.nodes.get("b")?.communityId).toBe(1);
	});

	it("foregrounds paths and pulses cycles", () => {
		const paths = encodeResult({
			kind: "paths",
			paths: [{ nodes: ["a", "b"], edges: [{ source: "a", target: "b" }] }],
		});
		expect(paths.channel).toBe("foreground");
		expect(paths.foregroundPaths).toHaveLength(1);

		const cycles = encodeResult({
			kind: "cycles",
			cycles: [{ nodes: ["a", "b", "a"], edges: [] }],
		});
		expect(cycles.channel).toBe("edge-pulse");
		expect(cycles.pulseCycles).toHaveLength(1);
	});

	it("normalize collapses an all-equal map without NaN", () => {
		const out = normalize(
			new Map([
				["a", 5],
				["b", 5],
			]),
		);
		expect(out.get("a")).toBe(1);
		expect(out.get("b")).toBe(1);
	});

	it("defaultChannelFor maps every result kind", () => {
		expect(defaultChannelFor("scores")).toBe("brightness");
		expect(defaultChannelFor("communities")).toBe("color-categorical");
		expect(defaultChannelFor("paths")).toBe("foreground");
		expect(defaultChannelFor("cycles")).toBe("edge-pulse");
		expect(defaultChannelFor("derived")).toBe("none");
	});
});
