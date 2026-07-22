import { eigenvectorCentrality } from "../algorithms/eigenvector-centrality";
import type { SubGraph } from "../types";

async function scores(graph: SubGraph): Promise<Map<string, number>> {
	const result = await eigenvectorCentrality.run(graph, {});
	if (result.kind !== "scores") throw new Error("expected scores result");
	return result.values;
}

describe("eigenvector-centrality", () => {
	it("ranks the hub of a star above its leaves (K_{1,4} → hub=1, leaf=0.5)", async () => {
		const graph: SubGraph = {
			nodes: ["hub", "a", "b", "c", "d"].map((id) => ({ id })),
			edges: ["a", "b", "c", "d"].map((leaf) => ({
				source: "hub",
				target: leaf,
			})),
		};
		const s = await scores(graph);
		expect(s.get("hub")).toBeCloseTo(1, 5);
		for (const leaf of ["a", "b", "c", "d"]) {
			expect(s.get(leaf)).toBeCloseTo(0.5, 2);
		}
	});

	it("ranks the middle of a path above its ends", async () => {
		const graph: SubGraph = {
			nodes: ["x", "y", "z"].map((id) => ({ id })),
			edges: [
				{ source: "x", target: "y" },
				{ source: "y", target: "z" },
			],
		};
		const s = await scores(graph);
		expect(s.get("y")).toBeCloseTo(1, 5);
		expect(s.get("x")).toBeLessThan(1);
		expect(s.get("x")).toBeCloseTo(s.get("z") as number, 5);
	});

	it("returns all-zero when there are no edges (no influence flow)", async () => {
		const s = await scores({ nodes: [{ id: "lonely" }], edges: [] });
		expect(s.get("lonely")).toBe(0);
	});

	it("returns an empty map for an empty working set", async () => {
		const s = await scores({ nodes: [], edges: [] });
		expect(s.size).toBe(0);
	});

	it("weights edges (a heavier tie pulls more centrality)", async () => {
		const graph: SubGraph = {
			nodes: ["a", "b", "c"].map((id) => ({ id })),
			edges: [
				{ source: "a", target: "b", weight: 10 },
				{ source: "b", target: "c", weight: 1 },
			],
		};
		const s = await scores(graph);
		// b sits on the heavy a-b tie → most central.
		expect(s.get("b")).toBeCloseTo(1, 5);
		expect(s.get("a")).toBeGreaterThan(s.get("c") as number);
	});
});
