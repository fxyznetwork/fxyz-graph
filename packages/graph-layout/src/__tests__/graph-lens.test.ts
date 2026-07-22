import {
	COMMUNITY_PALETTE,
	computeLensColors,
	type LensLink,
	type LensNode,
	LOUVAIN_PRECOMPUTE_COVERAGE_THRESHOLD,
} from "../graph-lens";

/** Two obvious 3-cliques joined by one bridge edge — Louvain reads 2 communities. */
function twoCliques(): { nodes: LensNode[]; links: LensLink[] } {
	const nodes: LensNode[] = ["a1", "a2", "a3", "b1", "b2", "b3"].map((id) => ({
		id,
	}));
	const links: LensLink[] = [
		{ source: "a1", target: "a2" },
		{ source: "a2", target: "a3" },
		{ source: "a3", target: "a1" },
		{ source: "b1", target: "b2" },
		{ source: "b2", target: "b3" },
		{ source: "b3", target: "b1" },
		{ source: "a1", target: "b1" },
	];
	return { nodes, links };
}

describe("communities lens — precompute preference", () => {
	it("colours from properties.louvainCommunity when coverage meets the threshold, skipping client Louvain", () => {
		const { nodes, links } = twoCliques();
		// 100% coverage; ids deliberately contradict the topology (a-clique split
		// 5/6) so a client-side Louvain run would produce DIFFERENT colours —
		// proving the precompute branch was taken.
		const withPrecompute = nodes.map((n, i) => ({
			...n,
			properties: { louvainCommunity: i < 3 ? (i < 2 ? 5 : 6) : 1 },
		}));
		const map = computeLensColors("communities", withPrecompute, links);
		expect(map.get("a1")).toBe(COMMUNITY_PALETTE[5]);
		expect(map.get("a2")).toBe(COMMUNITY_PALETTE[5]);
		expect(map.get("a3")).toBe(COMMUNITY_PALETTE[6]);
		expect(map.get("b1")).toBe(COMMUNITY_PALETTE[1]);
		expect(map.get("b2")).toBe(COMMUNITY_PALETTE[1]);
		expect(map.get("b3")).toBe(COMMUNITY_PALETTE[1]);
	});

	it("wraps precomputed ids into the palette (id % length, negatives included)", () => {
		const nodes: LensNode[] = [
			{ id: "n0", properties: { louvainCommunity: COMMUNITY_PALETTE.length } },
			{
				id: "n1",
				properties: { louvainCommunity: COMMUNITY_PALETTE.length + 3 },
			},
			{ id: "n2", properties: { louvainCommunity: -1 } },
		];
		const map = computeLensColors("communities", nodes, []);
		expect(map.get("n0")).toBe(COMMUNITY_PALETTE[0]);
		expect(map.get("n1")).toBe(COMMUNITY_PALETTE[3]);
		expect(map.get("n2")).toBe(COMMUNITY_PALETTE[COMMUNITY_PALETTE.length - 1]);
	});

	it("falls back to client-side Louvain below the coverage threshold", () => {
		const { nodes, links } = twoCliques();
		// 1 of 6 nodes precomputed (~17% < threshold) — the lens must ignore the
		// partial precompute and compute the partition itself.
		const sparse = nodes.map((n, i) =>
			i === 0 ? { ...n, properties: { louvainCommunity: 7 } } : n,
		);
		const map = computeLensColors("communities", sparse, links);
		// Every node gets a colour (client run covers all six)…
		expect(map.size).toBe(6);
		// …the cliques agree internally and differ from each other…
		expect(map.get("a1")).toBe(map.get("a2"));
		expect(map.get("a2")).toBe(map.get("a3"));
		expect(map.get("b1")).toBe(map.get("b2"));
		expect(map.get("b2")).toBe(map.get("b3"));
		expect(map.get("a1")).not.toBe(map.get("b1"));
	});

	it("ignores non-numeric louvainCommunity values when measuring coverage", () => {
		const { nodes, links } = twoCliques();
		const junk = nodes.map((n) => ({
			...n,
			properties: { louvainCommunity: "3" }, // string — not a precompute
		}));
		const map = computeLensColors("communities", junk, links);
		// Fallback ran: topology-derived split, not everything on palette[3].
		expect(map.get("a1")).not.toBe(map.get("b2"));
	});

	it("keeps the empty-graph behaviour (no edges → no communities)", () => {
		const nodes: LensNode[] = [{ id: "solo" }];
		const map = computeLensColors("communities", nodes, []);
		expect(map.size).toBe(0);
	});

	it("documents the threshold as a clear majority", () => {
		expect(LOUVAIN_PRECOMPUTE_COVERAGE_THRESHOLD).toBeGreaterThan(0.5);
		expect(LOUVAIN_PRECOMPUTE_COVERAGE_THRESHOLD).toBeLessThanOrEqual(1);
	});
});
