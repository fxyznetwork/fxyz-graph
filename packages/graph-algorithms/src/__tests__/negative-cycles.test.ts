import { BUILTIN_ALGORITHMS } from "../algorithms";
import { negativeCycles } from "../algorithms/negative-cycles";
import type { AlgoCycle, SubGraph } from "../types";

async function detect(graph: SubGraph): Promise<AlgoCycle[]> {
	const result = await negativeCycles.run(graph, {});
	if (result.kind !== "cycles") throw new Error("expected cycles result");
	return result.cycles;
}

describe("negative-cycles", () => {
	it("finds the arbitrage loop when rates multiply above 1 around a cycle", async () => {
		// USD→EUR (0.9) →GBP (0.85) →USD (1.5) compounds to 1.1475 > 1, so the
		// -ln(rate) weights sum negative — a textbook arbitrage cycle.
		const graph: SubGraph = {
			nodes: ["USD", "EUR", "GBP"].map((id) => ({ id })),
			edges: [
				{ source: "USD", target: "EUR", properties: { rate: 0.9 } },
				{ source: "EUR", target: "GBP", properties: { rate: 0.85 } },
				{ source: "GBP", target: "USD", properties: { rate: 1.5 } },
			],
		};
		const cycles = await detect(graph);
		expect(cycles).toHaveLength(1);
		const cycle = cycles[0];
		// Closing convention: first node repeated last (["a","b","a"] style).
		expect(cycle.nodes).toHaveLength(4);
		expect(cycle.nodes[0]).toBe(cycle.nodes[cycle.nodes.length - 1]);
		expect(new Set(cycle.nodes)).toEqual(new Set(["USD", "EUR", "GBP"]));
		expect(cycle.edges).toHaveLength(3);
		expect(cycle.meta?.gain).toBeCloseTo(1.1475, 4);
		expect(cycle.meta?.totalWeight as number).toBeLessThan(0);
	});

	it("returns an empty cycles result on a balanced (no-arbitrage) FX loop", async () => {
		// 0.9 × 0.85 × 1.2 = 0.918 < 1 — the loop loses money, weights sum positive.
		const graph: SubGraph = {
			nodes: ["USD", "EUR", "GBP"].map((id) => ({ id })),
			edges: [
				{ source: "USD", target: "EUR", properties: { rate: 0.9 } },
				{ source: "EUR", target: "GBP", properties: { rate: 0.85 } },
				{ source: "GBP", target: "USD", properties: { rate: 1.2 } },
			],
		};
		const result = await negativeCycles.run(graph, {});
		expect(result).toEqual({ kind: "cycles", cycles: [] });
	});

	it("returns an empty cycles result on an acyclic graph", async () => {
		const graph: SubGraph = {
			nodes: ["a", "b", "c"].map((id) => ({ id })),
			edges: [
				{ source: "a", target: "b", weight: -2 },
				{ source: "b", target: "c", weight: -3 },
			],
		};
		const result = await negativeCycles.run(graph, {});
		expect(result).toEqual({ kind: "cycles", cycles: [] });
	});

	it("detects a negative loop given explicit additive weights", async () => {
		const graph: SubGraph = {
			nodes: ["a", "b", "c", "d"].map((id) => ({ id })),
			edges: [
				// Negative 2-cycle a↔b (sum -1) …
				{ source: "a", target: "b", weight: 2 },
				{ source: "b", target: "a", weight: -3 },
				// … plus a positive tail that must NOT be reported.
				{ source: "b", target: "c", weight: 1 },
				{ source: "c", target: "d", weight: 1 },
			],
		};
		const cycles = await detect(graph);
		expect(cycles).toHaveLength(1);
		expect(new Set(cycles[0].nodes)).toEqual(new Set(["a", "b"]));
		expect(cycles[0].meta?.totalWeight).toBeCloseTo(-1, 6);
	});

	it("deduplicates one cycle discovered from multiple witnesses", async () => {
		// Every node on the triangle is a witness after the extra pass; the
		// rotation-canonical key must collapse them to a single reported cycle.
		const graph: SubGraph = {
			nodes: ["x", "y", "z"].map((id) => ({ id })),
			edges: [
				{ source: "x", target: "y", weight: -1 },
				{ source: "y", target: "z", weight: -1 },
				{ source: "z", target: "x", weight: -1 },
			],
		};
		const cycles = await detect(graph);
		expect(cycles).toHaveLength(1);
		expect(cycles[0].meta?.totalWeight).toBeCloseTo(-3, 6);
	});

	it("handles an empty working set", async () => {
		const result = await negativeCycles.run({ nodes: [], edges: [] }, {});
		expect(result).toEqual({ kind: "cycles", cycles: [] });
	});

	it("is registered among the built-in algorithms with the cycles kind", () => {
		const row = BUILTIN_ALGORITHMS.find((a) => a.id === "negative-cycles");
		expect(row).toBeDefined();
		expect(row?.family).toBe("cycle");
		expect(row?.resultKind).toBe("cycles");
		expect(row?.defaultEncodingChannel).toBe("edge-pulse");
	});
});
