import { cheapestRoute } from "../algorithms/cheapest-route";
import type { AlgoPath, SubGraph } from "../types";

async function route(
	graph: SubGraph,
	source: string,
	target: string,
): Promise<AlgoPath[]> {
	const result = await cheapestRoute.run(graph, { source, target });
	if (result.kind !== "paths") throw new Error("expected paths result");
	return result.paths;
}

describe("cheapest-route", () => {
	it("prefers the best-compounded FX path over the worse direct rate", async () => {
		// USD→EUR (0.9) →GBP (0.85) compounds to 0.765 > direct USD→GBP (0.75).
		const graph: SubGraph = {
			nodes: ["USD", "EUR", "GBP"].map((id) => ({ id })),
			edges: [
				{ source: "USD", target: "EUR", properties: { rate: 0.9 } },
				{ source: "EUR", target: "GBP", properties: { rate: 0.85 } },
				{ source: "USD", target: "GBP", properties: { rate: 0.75 } },
			],
		};
		const paths = await route(graph, "USD", "GBP");
		expect(paths).toHaveLength(1);
		expect(paths[0].nodes).toEqual(["USD", "EUR", "GBP"]);
		expect(paths[0].meta?.compoundedRate).toBeCloseTo(0.765, 4);
		expect(paths[0].meta?.hops).toBe(2);
	});

	it("minimizes additive explicit weights (cheaper 2-hop beats costly direct)", async () => {
		const graph: SubGraph = {
			nodes: ["a", "b", "c"].map((id) => ({ id })),
			edges: [
				{ source: "a", target: "b", weight: 5 },
				{ source: "a", target: "c", weight: 1 },
				{ source: "c", target: "b", weight: 1 },
			],
		};
		const paths = await route(graph, "a", "b");
		expect(paths[0].nodes).toEqual(["a", "c", "b"]);
		expect(paths[0].totalWeight).toBeCloseTo(2, 6);
	});

	it("returns no path when the target is unreachable", async () => {
		const graph: SubGraph = {
			nodes: ["a", "b", "island"].map((id) => ({ id })),
			edges: [{ source: "a", target: "b", weight: 1 }],
		};
		expect(await route(graph, "a", "island")).toHaveLength(0);
	});

	it("returns no path when an endpoint is absent from the working set", async () => {
		const graph: SubGraph = {
			nodes: [{ id: "a" }],
			edges: [],
		};
		expect(await route(graph, "a", "ghost")).toHaveLength(0);
	});
});
