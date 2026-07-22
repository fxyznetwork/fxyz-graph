/**
 * Positions precompute — pure-module laws (#580 step 2).
 *
 * Locks: determinism (identical input → byte-identical output), provable
 * full coverage (NaN-fill + sweep), community cohesion (members inside their
 * disc), disc separation, the phyllotaxis fallback for giant communities,
 * singleton bucket placement, warm-start seeding, and empty-input safety.
 */

import Graph from "graphology";
import type { Slice } from "../precompute-louvain-core";
import { COMPUTE_LABELS } from "../precompute-louvain-core";
import {
	computePositions,
	discRadius,
	FORCE_COMMUNITY_MAX,
	overviewRadius,
	type PositionSummaryLink,
	type PositionSummaryNode,
} from "../precompute-positions";

/** Build a Slice with `n` nodes (all labelIdx 0) and the given edges. */
function makeSlice(n: number, edges: Array<[number, number]>): Slice {
	const graph = new Graph({ multi: false, type: "undirected" });
	const ids: string[] = [];
	const labelIdx: number[] = [];
	for (let i = 0; i < n; i++) {
		ids.push(`el-${String(i).padStart(5, "0")}`);
		labelIdx.push(0);
		graph.addNode(String(i));
	}
	for (const [a, b] of edges) graph.mergeEdge(String(a), String(b));
	return { ids, labelIdx, graph };
}

/** Two triangle communities bridged by one edge + two singletons. */
function twoCommunityFixture() {
	const slice = makeSlice(8, [
		[0, 1],
		[1, 2],
		[2, 0],
		[3, 4],
		[4, 5],
		[5, 3],
		[2, 3],
	]);
	const members = new Map<number, number[]>([
		[0, [0, 1, 2]],
		[1, [3, 4, 5]],
		[2, [6]],
		[3, [7]],
	]);
	const label = COMPUTE_LABELS[0] as string;
	const summaryNodes: PositionSummaryNode[] = [
		{ id: "louvain-community-0", kind: "community", communityId: 0, size: 3 },
		{ id: "louvain-community-1", kind: "community", communityId: 1, size: 3 },
		{
			id: `label-bucket-${label}`,
			kind: "label-bucket",
			bucketLabel: label,
			size: 2,
		},
	];
	const summaryLinks: PositionSummaryLink[] = [
		{ source: "louvain-community-0", target: "louvain-community-1", weight: 1 },
	];
	return { slice, members, summaryNodes, summaryLinks, label };
}

describe("computePositions — laws", () => {
	it("is deterministic: identical input → identical output", async () => {
		const a = await computePositions(twoCommunityFixture());
		const b = await computePositions(twoCommunityFixture());
		expect([...a.nodeX]).toEqual([...b.nodeX]);
		expect([...a.nodeY]).toEqual([...b.nodeY]);
		expect([...a.summaryPositions.entries()]).toEqual([
			...b.summaryPositions.entries(),
		]);
	});

	it("positions every slice node — zero unpositioned, zero NaN", async () => {
		const res = await computePositions(twoCommunityFixture());
		expect(res.unpositioned).toBe(0);
		for (let i = 0; i < res.nodeX.length; i++) {
			expect(Number.isFinite(res.nodeX[i])).toBe(true);
			expect(Number.isFinite(res.nodeY[i])).toBe(true);
		}
		expect(res.forceLaidOut + res.phyllotaxisLaidOut).toBe(8);
	});

	it("keeps community members inside their community's disc", async () => {
		const fixture = twoCommunityFixture();
		const res = await computePositions(fixture);
		for (const [cid, idxs] of fixture.members) {
			if (idxs.length < 2) continue;
			const center = res.summaryPositions.get(`louvain-community-${cid}`);
			expect(center).toBeDefined();
			if (!center) continue;
			for (const idx of idxs) {
				const d = Math.hypot(
					(res.nodeX[idx] as number) - center.x,
					(res.nodeY[idx] as number) - center.y,
				);
				expect(d).toBeLessThanOrEqual(center.r * 1.0001);
			}
		}
	});

	it("separates summary discs (collide keeps centroids apart)", async () => {
		const res = await computePositions(twoCommunityFixture());
		const entries = [...res.summaryPositions.entries()];
		for (let i = 0; i < entries.length; i++) {
			for (let j = i + 1; j < entries.length; j++) {
				const [, a] = entries[i] as [
					string,
					{ x: number; y: number; r: number },
				];
				const [, b] = entries[j] as [
					string,
					{ x: number; y: number; r: number },
				];
				const d = Math.hypot(a.x - b.x, a.y - b.y);
				expect(d).toBeGreaterThanOrEqual((a.r + b.r) * 0.5);
			}
		}
	});

	it("routes giant communities through the phyllotaxis fallback, still inside the disc", async () => {
		const n = FORCE_COMMUNITY_MAX + 10;
		const edges: Array<[number, number]> = [];
		for (let i = 1; i < n; i++) edges.push([0, i]); // star hub
		const slice = makeSlice(n, edges);
		const members = new Map<number, number[]>([
			[0, Array.from({ length: n }, (_, i) => i)],
		]);
		const summaryNodes: PositionSummaryNode[] = [
			{ id: "louvain-community-0", kind: "community", communityId: 0, size: n },
		];
		const res = await computePositions({
			slice,
			members,
			summaryNodes,
			summaryLinks: [],
		});
		expect(res.phyllotaxisLaidOut).toBe(n);
		expect(res.forceLaidOut).toBe(0);
		const center = res.summaryPositions.get("louvain-community-0");
		expect(center).toBeDefined();
		if (!center) return;
		for (let i = 0; i < n; i++) {
			const d = Math.hypot(
				(res.nodeX[i] as number) - center.x,
				(res.nodeY[i] as number) - center.y,
			);
			expect(d).toBeLessThanOrEqual(center.r * 1.0001);
		}
	});

	it("places Louvain singletons inside their label bucket's disc", async () => {
		const fixture = twoCommunityFixture();
		const res = await computePositions(fixture);
		const bucket = res.summaryPositions.get(`label-bucket-${fixture.label}`);
		expect(bucket).toBeDefined();
		if (!bucket) return;
		for (const idx of [6, 7]) {
			const d = Math.hypot(
				(res.nodeX[idx] as number) - bucket.x,
				(res.nodeY[idx] as number) - bucket.y,
			);
			expect(d).toBeLessThanOrEqual(bucket.r * 1.0001);
		}
	});

	it("parks + counts members whose bucket is missing from the summary tier", async () => {
		const fixture = twoCommunityFixture();
		// Drop the bucket — singletons 6/7 have nowhere to go.
		const summaryNodes = fixture.summaryNodes.filter(
			(s) => s.kind !== "label-bucket",
		);
		const res = await computePositions({ ...fixture, summaryNodes });
		// They are parked (finite), not lost — and NOT counted as unpositioned
		// (the bucket-missing branch handles them explicitly).
		for (const idx of [6, 7]) {
			expect(Number.isFinite(res.nodeX[idx])).toBe(true);
			expect(Number.isFinite(res.nodeY[idx])).toBe(true);
		}
		expect(res.unpositioned).toBe(0);
	});

	it("honors warm-start priors as seeds (zero iterations → exact carry-over)", async () => {
		const fixture = twoCommunityFixture();
		const first = await computePositions(fixture);
		const priors = new Map<number, { x: number; y: number }>();
		for (const idx of [0, 1, 2]) {
			priors.set(idx, {
				x: first.nodeX[idx] as number,
				y: first.nodeY[idx] as number,
			});
		}
		const second = await computePositions({
			...fixture,
			priorPositions: priors,
			summaryIterations: 0,
			memberIterationsCap: 0,
		});
		// The mental-map property: warm members keep their intra-community SHAPE
		// (pairwise distances) wherever the disc lands in the new run — priors
		// are re-based on the community's prior centroid, not carried absolutely.
		const pairs: Array<[number, number]> = [
			[0, 1],
			[1, 2],
			[0, 2],
		];
		for (const [a, b] of pairs) {
			const d1 = Math.hypot(
				(first.nodeX[a] as number) - (first.nodeX[b] as number),
				(first.nodeY[a] as number) - (first.nodeY[b] as number),
			);
			const d2 = Math.hypot(
				(second.nodeX[a] as number) - (second.nodeX[b] as number),
				(second.nodeY[a] as number) - (second.nodeY[b] as number),
			);
			expect(d2).toBeCloseTo(d1, 6);
		}
	});

	it("singleton placement is INSERTION-STABLE: adding a member never moves the others", async () => {
		const label = COMPUTE_LABELS[0] as string;
		// Same declared summary tier in both runs (size 3) — isolates the
		// placement law from disc-radius changes.
		const summaryNodes: PositionSummaryNode[] = [
			{
				id: `label-bucket-${label}`,
				kind: "label-bucket",
				bucketLabel: label,
				size: 3,
			},
		];
		const two = await computePositions({
			slice: makeSlice(2, []),
			members: new Map([
				[0, [0]],
				[1, [1]],
			]),
			summaryNodes,
			summaryLinks: [],
		});
		const three = await computePositions({
			slice: makeSlice(3, []),
			members: new Map([
				[0, [0]],
				[1, [1]],
				[2, [2]],
			]),
			summaryNodes,
			summaryLinks: [],
		});
		// makeSlice ids are index-derived, so nodes 0/1 carry identical ids in
		// both runs — their positions must be identical too.
		for (const idx of [0, 1]) {
			expect(three.nodeX[idx]).toBe(two.nodeX[idx]);
			expect(three.nodeY[idx]).toBe(two.nodeY[idx]);
		}
	});

	it("handles an empty slice without throwing", async () => {
		const res = await computePositions({
			slice: makeSlice(0, []),
			members: new Map(),
			summaryNodes: [],
			summaryLinks: [],
		});
		expect(res.nodeX.length).toBe(0);
		expect(res.unpositioned).toBe(0);
		expect(res.summaryPositions.size).toBe(0);
	});

	it("discRadius grows with sqrt(size) and never collapses", () => {
		expect(discRadius(1)).toBeGreaterThan(0);
		expect(discRadius(10_000)).toBeGreaterThan(discRadius(100));
		// √ scaling: 100× the size ⇒ ~10× the radius.
		expect(discRadius(10_000) / discRadius(100)).toBeCloseTo(10, 0);
	});
});

/** Prod-shaped summary tier: a few giants + a linked core + isolated tail —
 *  the shape that made the world layout read as empty space (tm #1080). */
function overviewFixture() {
	const sizes = [
		19_321, 18_898, 7_061, 4_329, 3_670, 1_355, 900, 640, 400, 250, 160, 120,
		90, 70, 55, 40, 30, 22, 16, 12, 9, 7, 5, 4, 3, 3, 2, 2, 2, 2,
	];
	const summaryNodes: PositionSummaryNode[] = sizes.map((size, i) => ({
		id: `louvain-community-${i}`,
		kind: "community" as const,
		communityId: i,
		size,
	}));
	// Sparse linked core (like prod's 60 links / 134 nodes) — the tail stays
	// isolated on purpose: centering must reel it in, not links.
	const summaryLinks: PositionSummaryLink[] = [
		{ source: "louvain-community-0", target: "louvain-community-2", weight: 9 },
		{ source: "louvain-community-2", target: "louvain-community-3", weight: 4 },
		{ source: "louvain-community-3", target: "louvain-community-5", weight: 2 },
		{ source: "louvain-community-1", target: "louvain-community-4", weight: 6 },
		{ source: "louvain-community-6", target: "louvain-community-7", weight: 1 },
	];
	return {
		slice: makeSlice(0, []),
		members: new Map<number, number[]>(),
		summaryNodes,
		summaryLinks,
	};
}

describe("layoutOverviewTier — render-scale overview laws (tm #1080)", () => {
	it("is deterministic and covers every summary object with finite positions", async () => {
		const a = await computePositions(overviewFixture());
		const b = await computePositions(overviewFixture());
		expect([...a.overviewPositions.entries()]).toEqual([
			...b.overviewPositions.entries(),
		]);
		expect(a.overviewPositions.size).toBe(overviewFixture().summaryNodes.length);
		for (const p of a.overviewPositions.values()) {
			expect(Number.isFinite(p.x)).toBe(true);
			expect(Number.isFinite(p.y)).toBe(true);
		}
	});

	it("compacts to render scale: extent bounded regardless of world disc scale", async () => {
		const res = await computePositions(overviewFixture());
		// World layout reserves containment discs (discRadius(19321) ≈ 4,000
		// units); the overview must live at drawn-pixel scale instead.
		let worldMax = 0;
		for (const p of res.summaryPositions.values()) {
			worldMax = Math.max(worldMax, Math.abs(p.x), Math.abs(p.y));
		}
		let ovMax = 0;
		for (const p of res.overviewPositions.values()) {
			ovMax = Math.max(ovMax, Math.abs(p.x), Math.abs(p.y));
		}
		expect(worldMax).toBeGreaterThan(2_000); // fixture really is giant-scale
		expect(ovMax).toBeLessThan(1_500); // overview stays near the target extent
	});

	it("keeps discs separated at DRAWN radii (the 2026-07-18 lump law)", async () => {
		// The first version of this law tolerated 75% overlap ((rA+rB)·0.5 on
		// radii that were themselves half the drawn size) — the founder's
		// "unusable lump" screenshot is what that tolerance shipped. The bound
		// is now near-touching at the true lens radii: a force layout may leave
		// hairline contact, never a pile.
		const res = await computePositions(overviewFixture());
		const fixture = overviewFixture();
		const sizeById = new Map(fixture.summaryNodes.map((n) => [n.id, n.size]));
		const entries = [...res.overviewPositions.entries()];
		for (let i = 0; i < entries.length; i++) {
			for (let j = i + 1; j < entries.length; j++) {
				const [idA, a] = entries[i] as [string, { x: number; y: number }];
				const [idB, b] = entries[j] as [string, { x: number; y: number }];
				const minSep =
					(overviewRadius(sizeById.get(idA) ?? 1) +
						overviewRadius(sizeById.get(idB) ?? 1)) *
					0.9;
				expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(minSep);
			}
		}
	});

	it("zero iterations → pure world seed scaled into the target extent", async () => {
		const fixture = overviewFixture();
		const res = await computePositions({ ...fixture, summaryIterations: 0 });
		let worldMax = 0;
		for (const p of res.summaryPositions.values()) {
			worldMax = Math.max(worldMax, Math.abs(p.x), Math.abs(p.y));
		}
		const scale = worldMax > 0 ? 500 / worldMax : 1;
		for (const [id, ov] of res.overviewPositions) {
			const w = res.summaryPositions.get(id);
			expect(w).toBeDefined();
			if (!w) continue;
			expect(ov.x).toBeCloseTo(w.x * scale, 6);
			expect(ov.y).toBeCloseTo(w.y * scale, 6);
		}
	});

	it("overviewRadius mirrors sizeFromValue EXACTLY (round(2·√v), diameter clamped 6..48)", () => {
		// Lens-side truth: packages/graph-engine/src/lens/apply.ts
		//   sizeFromValue(v) = min(48, max(6, round(2·√v)))  — a DIAMETER.
		// These assertions are the lens's own numbers, not this module's — if
		// either side changes formula, this law breaks loudly.
		const lensSizeFromValue = (v: number) =>
			v <= 0 ? 6 : Math.min(48, Math.max(6, Math.round(2 * Math.sqrt(v))));
		for (const size of [1, 4, 9, 25, 100, 400, 576, 2304, 19_321]) {
			expect(overviewRadius(size)).toBe(lensSizeFromValue(size) / 2);
		}
		expect(overviewRadius(1)).toBe(3); // min diameter 6 → radius 3
		expect(overviewRadius(100)).toBe(10); // 2·√100 = 20 diameter → radius 10
		expect(overviewRadius(400)).toBe(20); // 2·√400 = 40 diameter → radius 20
		expect(overviewRadius(576)).toBe(24); // 2·√576 = 48 → cap reached
		expect(overviewRadius(19_321)).toBe(24); // capped at 48 diameter
	});
});
