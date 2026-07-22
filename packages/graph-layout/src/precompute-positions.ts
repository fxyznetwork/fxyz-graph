/**
 * Positions precompute — deterministic server-side 2D layout for the
 * structural public slice (#580 step 2 / DESIGN-V2 §5 "positions" spine item).
 *
 * PURE compute module: no Neo4j session, no I/O — takes the already-streamed
 * slice + the Louvain community partition + the summary tier and returns
 * positions for every slice node and every summary object. The writer
 * (`precompute-louvain-core.ts`) owns persistence; this module owns geometry.
 *
 * Layout is HIERARCHICAL, mirroring the two-tier LOD the graph serves:
 *   1. SUMMARY layout — the ~135 summary objects (community super-nodes +
 *      label buckets) get a 2D force layout (links = aggregated
 *      GRAPH_COMMUNITY_LINK weights, collide radius ∝ √size) → each summary
 *      object becomes a DISC (centroid x/y + radius r).
 *   2. MEMBER layout — each community's members are laid out INSIDE its disc:
 *      a small local force sim (intra-community edges only) for communities up
 *      to FORCE_COMMUNITY_MAX, a deterministic degree-ranked phyllotaxis disc
 *      beyond that. Louvain singletons land in their label bucket's disc.
 *
 * Why hierarchical instead of one global 60k-node sim: (a) zooming from a
 * community super-node into its expanded members lands in the same region —
 * the Overview→drill-down continuity the LOD tier exists for; (b) runtime is
 * the sum of many small sims instead of one giant many-body pass; (c) each
 * sub-sim is independent, so the loop can yield to the event loop between
 * communities (the writer runs inside the serving API container via the cron
 * route — tm #912).
 *
 * Determinism: no Math.random anywhere in THIS module — initial positions are
 * phyllotaxis by deterministic rank (degree, then elementId tiebreak) and the
 * fixed-tick d3-force pass is deterministic given identical initial positions
 * (the landing-substrate precedent, force-layout.ts, relies on the same
 * property). Cross-FIRE stability is warm-start's job: pass `priorPositions`
 * (read from the previous fire's graphX/graphY) and existing nodes keep their
 * neighborhood instead of re-scattering.
 *
 * COORDINATE CONTRACT (documented for every consumer): origin-centered world
 * units, whole-graph extent roughly ±(a few thousand) — NOT pixels, NOT
 * normalized. Consumers (NVL layout:free + setNodePositions, GraphPane,
 * anything reading graphX/graphY) MUST fit-to-viewport on load and never
 * assume a fixed scale.
 */

import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
} from "d3-force-3d";
import type { Slice } from "./precompute-louvain-core";
import { COMPUTE_LABELS } from "./precompute-louvain-core";

/** Golden angle (radians) — phyllotaxis spiral increment. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Base member spacing in world units — everything else derives from this. */
const NODE_SPACING = 24;

/** Communities larger than this skip the force sub-sim (deterministic
 *  phyllotaxis disc instead) — keeps the worst-case community cheap. */
export const FORCE_COMMUNITY_MAX = 1500;

/** Summary-tier force pass tick count (135-object sim — cheap). */
const SUMMARY_ITERATIONS = 300;

/**
 * Overview render-scale constants (tm #1080). The world summary layout packs
 * discs at MEMBER-CONTAINMENT radii (discRadius ~ 24·1.2·√size — OFAC@19k
 * reserves ~4,000 units) while the public-overview lens renders every node
 * clamped to 6..48 px — so the world layout reads as vast empty space with
 * viewport-crossing edges (prod 2026-07-17: bbox 18.8k×13.7k, median nn 159
 * vs max 4,375, worst edge 32% of the diagonal). The overview pass lays the
 * SAME summary graph out at the scale the lens actually draws.
 */
const OVERVIEW_MIN_DIAMETER = 6;
const OVERVIEW_MAX_DIAMETER = 48;
/** Collide slack per disc — room for the edge-anchored label line. */
const OVERVIEW_LABEL_PAD = 14;
/** Target half-extent of the seed cloud (≈ px at a ~1000px viewport; the
 *  pane fits-to-viewport regardless — this only sets density vs node size). */
const OVERVIEW_TARGET_HALF_WIDTH = 500;

/** Max milliseconds of continuous member-pass compute before yielding to the
 *  event loop — the fire runs inside the serving API container, so blocks are
 *  time-budgeted, not count-budgeted (a run of large sub-sims must not stack). */
const YIELD_BUDGET_MS = 40;

/** Minimal summary-object shape the layout needs (subset of the writer's
 *  SummaryNode — kept structural so the two evolve together via the writer). */
export interface PositionSummaryNode {
	id: string;
	kind: string;
	communityId?: number;
	bucketLabel?: string;
	size: number;
}

export interface PositionSummaryLink {
	source: string;
	target: string;
	weight: number;
}

export interface ComputePositionsInput {
	slice: Slice;
	/** community id → member slice indices (the writer's communityMembers map). */
	members: Map<number, number[]>;
	summaryNodes: PositionSummaryNode[];
	summaryLinks: PositionSummaryLink[];
	/**
	 * Warm start — slice index → previous fire's position. Existing nodes seed
	 * at their prior spot (then relax), so weekly re-fires don't re-scatter the
	 * mental map. Nodes absent from the map seed deterministically.
	 */
	priorPositions?: Map<number, { x: number; y: number }>;
	/** Test hook — 0 skips all force ticks (pure deterministic seeding). */
	summaryIterations?: number;
	/** Test hook — cap on per-community sub-sim ticks. */
	memberIterationsCap?: number;
}

export interface SummaryPosition {
	x: number;
	y: number;
	/** Disc radius the members were laid out within (world units). */
	r: number;
}

export interface ComputePositionsResult {
	/** slice index → position; every slice node gets one (coverage = 1). */
	nodeX: Float64Array;
	nodeY: Float64Array;
	/** summary object id → centroid + disc radius. */
	summaryPositions: Map<string, SummaryPosition>;
	/** summary object id → render-scale overview position (tm #1080) — the
	 *  SAME summary graph laid out at lens-draw scale; served as ovX/ovY. */
	overviewPositions: Map<string, { x: number; y: number }>;
	/** members positioned via force sub-sims vs phyllotaxis fallback. */
	forceLaidOut: number;
	phyllotaxisLaidOut: number;
	/** nodes NEITHER pass reached (defensively parked near origin) — a nonzero
	 *  value means partition/summary drift and should fail verification. */
	unpositioned: number;
	/** members that seeded from a prior position (mental-map warm start). */
	warmStarted: number;
	wallMs: number;
}

/** Disc radius for a summary object of `size` members. */
export function discRadius(size: number): number {
	return Math.max(NODE_SPACING * 2, NODE_SPACING * 1.2 * Math.sqrt(size));
}

/** Point k of a phyllotaxis disc of n points with radius R (k is 0-based). */
function phyllotaxisPoint(
	k: number,
	n: number,
	R: number,
): { x: number; y: number } {
	const radius = R * Math.sqrt((k + 0.5) / Math.max(n, 1));
	const angle = k * GOLDEN_ANGLE;
	return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

/** FNV-style hash of a string → [0, 1). */
function hash01(input: string, salt: number): number {
	let h = 2166136261 ^ salt;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) / 2 ** 32;
}

/**
 * INSERTION-STABLE disc placement keyed on the node's elementId — angle and
 * radius derive from the id alone, so a node keeps its spot forever no matter
 * how many neighbors join or leave the set. Used for the singleton/bucket
 * tail (~22.7k nodes on prod), where rank-indexed phyllotaxis would re-scatter
 * everyone whenever ONE membership changes (re-review finding). √ on the
 * radius hash keeps the density uniform-in-area.
 */
function hashDiscPoint(id: string, R: number): { x: number; y: number } {
	const angle = hash01(id, 7) * 2 * Math.PI;
	const radius = R * Math.sqrt(hash01(id, 11));
	return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

interface SimNode {
	id: string;
	x: number;
	y: number;
	r?: number;
}

/**
 * Level 1 — lay out the summary objects. Initial placement is a phyllotaxis
 * spiral ordered by size (largest central), then a fixed-tick force pass:
 * links pull connected communities together, collide keeps discs separated.
 */
function layoutSummaryTier(
	summaryNodes: PositionSummaryNode[],
	summaryLinks: PositionSummaryLink[],
	iterations: number,
): Map<string, SummaryPosition> {
	const out = new Map<string, SummaryPosition>();
	if (summaryNodes.length === 0) return out;

	// Deterministic order: size desc, id asc tiebreak.
	const ordered = [...summaryNodes].sort(
		(a, b) => b.size - a.size || (a.id < b.id ? -1 : 1),
	);
	// Spiral spacing scaled so discs start non-overlapping: total disc area
	// with a packing slack factor gives the spiral's outer radius.
	const totalArea = ordered.reduce((s, n) => {
		const r = discRadius(n.size);
		return s + Math.PI * r * r;
	}, 0);
	const spiralR = Math.sqrt((totalArea * 2.2) / Math.PI);

	const simNodes: SimNode[] = ordered.map((n, k) => {
		const p = phyllotaxisPoint(k, ordered.length, spiralR);
		return { id: n.id, x: p.x, y: p.y, r: discRadius(n.size) };
	});
	const byId = new Map(simNodes.map((n) => [n.id, n]));

	if (iterations > 0) {
		// Distances/strengths are precomputed onto the link rows — d3's forceLink
		// mutates source/target into node objects, so accessors can't resolve by
		// id after initialization.
		const maxWeight = summaryLinks.reduce((m, l) => Math.max(m, l.weight), 1);
		const links = summaryLinks
			.filter((l) => byId.has(l.source) && byId.has(l.target))
			.map((l) => ({
				...l,
				dist:
					((byId.get(l.source)?.r ?? NODE_SPACING) +
						(byId.get(l.target)?.r ?? NODE_SPACING)) *
					1.25,
				str: 0.1 + 0.4 * (l.weight / maxWeight),
			}));
		const sim = forceSimulation<SimNode>(simNodes, 2)
			.force(
				"link",
				forceLink<SimNode, { dist: number; str: number }>(links)
					.id((n) => n.id)
					.distance((l) => l.dist)
					.strength((l) => l.str),
			)
			.force("charge", forceManyBody<SimNode>().strength(-40))
			.force(
				"collide",
				forceCollide<SimNode>((n) => (n.r ?? NODE_SPACING) * 1.08).iterations(
					2,
				),
			)
			.force("cx", forceX<SimNode>(0).strength(0.02))
			.force("cy", forceY<SimNode>(0).strength(0.02))
			.alpha(1)
			.alphaDecay(1 - 0.001 ** (1 / iterations))
			.stop();
		for (let i = 0; i < iterations; i++) sim.tick();
	}

	for (const n of simNodes) {
		out.set(n.id, { x: n.x, y: n.y, r: n.r ?? NODE_SPACING });
	}
	return out;
}

/** Overview render radius for a summary object of `size` members — the TRUE
 *  mirror of the lens size channel: `sizeFromValue` in
 *  packages/graph-engine/src/lens/apply.ts draws diameter
 *  `round(2·√value)` clamped 6..48. The first version of this mirror used
 *  `√size` (HALF the drawn diameter below the clamp) — the collide pass
 *  reserved half the space the lens painted, which is the disc-overlap lump
 *  the founder screenshotted on 2026-07-18. Change one formula ⇒ change the
 *  other; the mirror law test locks them together with lens-side numbers. */
export function overviewRadius(size: number): number {
	return (
		Math.min(
			OVERVIEW_MAX_DIAMETER,
			Math.max(
				OVERVIEW_MIN_DIAMETER,
				Math.round(2 * Math.sqrt(Math.max(size, 1))),
			),
		) / 2
	);
}

/**
 * Level 1b — overview pass (tm #1080). Re-lays the summary graph at RENDER
 * scale: seeded from the world layout scaled into the target extent (coarse
 * neighborhoods survive), then link attraction + collide at drawn radii +
 * centering strong enough to reel isolated communities into one coherent
 * cloud. Deterministic: fixed seed order, fixed ticks, no randomness beyond
 * the world seed itself.
 */
function layoutOverviewTier(
	summaryNodes: PositionSummaryNode[],
	summaryLinks: PositionSummaryLink[],
	worldPositions: Map<string, SummaryPosition>,
	iterations: number,
): Map<string, { x: number; y: number }> {
	const out = new Map<string, { x: number; y: number }>();
	if (summaryNodes.length === 0) return out;

	let maxAbs = 0;
	for (const p of worldPositions.values()) {
		maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y));
	}
	const seedScale = maxAbs > 0 ? OVERVIEW_TARGET_HALF_WIDTH / maxAbs : 1;

	// Deterministic order: size desc, id asc tiebreak (matches the world tier).
	const ordered = [...summaryNodes].sort(
		(a, b) => b.size - a.size || (a.id < b.id ? -1 : 1),
	);
	const simNodes: SimNode[] = ordered.map((n, k) => {
		const w = worldPositions.get(n.id);
		const p = w
			? { x: w.x * seedScale, y: w.y * seedScale }
			: phyllotaxisPoint(k, ordered.length, OVERVIEW_TARGET_HALF_WIDTH);
		return { id: n.id, x: p.x, y: p.y, r: overviewRadius(n.size) };
	});
	const byId = new Map(simNodes.map((n) => [n.id, n]));

	if (iterations > 0) {
		const maxWeight = summaryLinks.reduce((m, l) => Math.max(m, l.weight), 1);
		const links = summaryLinks
			.filter((l) => byId.has(l.source) && byId.has(l.target))
			.map((l) => ({
				...l,
				dist:
					(byId.get(l.source)?.r ?? OVERVIEW_MIN_DIAMETER / 2) +
					(byId.get(l.target)?.r ?? OVERVIEW_MIN_DIAMETER / 2) +
					OVERVIEW_LABEL_PAD * 2,
				str: 0.2 + 0.5 * (l.weight / maxWeight),
			}));
		const sim = forceSimulation<SimNode>(simNodes, 2)
			.force(
				"link",
				forceLink<SimNode, { dist: number; str: number }>(links)
					.id((n) => n.id)
					.distance((l) => l.dist)
					.strength((l) => l.str),
			)
			.force("charge", forceManyBody<SimNode>().strength(-60))
			.force(
				"collide",
				forceCollide<SimNode>(
					(n) => (n.r ?? OVERVIEW_MIN_DIAMETER / 2) + OVERVIEW_LABEL_PAD,
				).iterations(3),
			)
			.force("cx", forceX<SimNode>(0).strength(0.07))
			.force("cy", forceY<SimNode>(0).strength(0.07))
			.alpha(1)
			.alphaDecay(1 - 0.001 ** (1 / iterations))
			.stop();
		for (let i = 0; i < iterations; i++) sim.tick();
		// Collide-only settle tail: link attraction (strength up to 0.7 on the
		// heaviest pairs) fights collide every tick and can end the fixed-tick
		// run with residual overlap. Dropping link+charge for a short tail lets
		// separation win the endgame deterministically; centering stays so the
		// cloud doesn't drift.
		sim.force("link", null).force("charge", null).alpha(0.3);
		const tail = Math.min(80, Math.max(20, Math.floor(iterations / 3)));
		for (let i = 0; i < tail; i++) sim.tick();
	}

	for (const n of simNodes) out.set(n.id, { x: n.x, y: n.y });
	return out;
}

/**
 * Level 2 — lay out one community's members inside its disc with a local
 * force sim over the intra-community edges, then scale-to-fit + offset.
 * Members arrive pre-sorted (degree desc) so hubs seed central.
 */
function layoutCommunityForce(
	slice: Slice,
	memberIdxs: number[],
	center: SummaryPosition,
	iterations: number,
	prior: Map<number, { x: number; y: number }> | undefined,
	nodeX: Float64Array,
	nodeY: Float64Array,
): number {
	const idxSet = new Set(memberIdxs);
	// Warm-start re-basing: prior positions are absolute, but the community's
	// disc may have moved between fires — so warm members seed at their offset
	// from the community's PRIOR centroid (mean of the members' priors), which
	// preserves the intra-community shape wherever the disc lands now.
	let priorMeanX = 0;
	let priorMeanY = 0;
	let warmCount = 0;
	if (prior) {
		for (const idx of memberIdxs) {
			const p = prior.get(idx);
			if (p) {
				priorMeanX += p.x;
				priorMeanY += p.y;
				warmCount++;
			}
		}
		if (warmCount > 0) {
			priorMeanX /= warmCount;
			priorMeanY /= warmCount;
		}
	}
	const simNodes: Array<SimNode & { idx: number }> = memberIdxs.map(
		(idx, k) => {
			const warm = warmCount > 0 ? prior?.get(idx) : undefined;
			const p = warm
				? { x: warm.x - priorMeanX, y: warm.y - priorMeanY }
				: phyllotaxisPoint(k, memberIdxs.length, center.r * 0.85);
			return { id: String(idx), idx, x: p.x, y: p.y };
		},
	);
	const links: Array<{ source: string; target: string }> = [];
	for (const idx of memberIdxs) {
		slice.graph.forEachNeighbor(String(idx), (nbr) => {
			const nIdx = Number(nbr);
			// Each undirected edge once (idx < nIdx), endpoints both in-community.
			if (nIdx > idx && idxSet.has(nIdx)) {
				links.push({ source: String(idx), target: String(nbr) });
			}
		});
	}

	if (iterations > 0) {
		const sim = forceSimulation<SimNode>(simNodes, 2)
			.force(
				"link",
				forceLink<SimNode, { source: string; target: string }>(links)
					.id((n) => n.id)
					.distance(NODE_SPACING)
					.strength(0.5),
			)
			.force("charge", forceManyBody<SimNode>().strength(-NODE_SPACING))
			.force(
				"collide",
				forceCollide<SimNode>(NODE_SPACING * 0.45).iterations(1),
			)
			.force("cx", forceX<SimNode>(0).strength(0.05))
			.force("cy", forceY<SimNode>(0).strength(0.05))
			.alpha(1)
			.alphaDecay(1 - 0.001 ** (1 / iterations))
			.stop();
		for (let i = 0; i < iterations; i++) sim.tick();
	}

	// Scale to fit the disc (shrink only when overflowing — small communities
	// keep their natural link-distance scale instead of stretching).
	let maxDist = 0;
	for (const n of simNodes) {
		const d = Math.hypot(n.x, n.y);
		if (d > maxDist) maxDist = d;
	}
	const fit = maxDist > center.r * 0.9 ? (center.r * 0.9) / maxDist : 1;
	for (const n of simNodes) {
		nodeX[n.idx] = center.x + n.x * fit;
		nodeY[n.idx] = center.y + n.y * fit;
	}
	return warmCount;
}

/** Level 2 fallback — deterministic phyllotaxis disc, hubs central. */
function layoutCommunityPhyllotaxis(
	memberIdxs: number[],
	center: SummaryPosition,
	nodeX: Float64Array,
	nodeY: Float64Array,
): void {
	for (let k = 0; k < memberIdxs.length; k++) {
		const idx = memberIdxs[k] as number;
		const p = phyllotaxisPoint(k, memberIdxs.length, center.r * 0.9);
		nodeX[idx] = center.x + p.x;
		nodeY[idx] = center.y + p.y;
	}
}

/** Deterministic member order: slice-graph degree desc, elementId asc. */
function rankMembers(slice: Slice, idxs: number[]): number[] {
	return [...idxs].sort((a, b) => {
		const d = slice.graph.degree(String(b)) - slice.graph.degree(String(a));
		if (d !== 0) return d;
		const ia = slice.ids[a] ?? "";
		const ib = slice.ids[b] ?? "";
		return ia < ib ? -1 : ia > ib ? 1 : 0;
	});
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Compute positions for every slice node + every summary object.
 * Async only for event-loop yields between community sub-sims.
 */
export async function computePositions(
	input: ComputePositionsInput,
): Promise<ComputePositionsResult> {
	const t0 = Date.now();
	const { slice, members, summaryNodes, summaryLinks } = input;
	const summaryIterations = input.summaryIterations ?? SUMMARY_ITERATIONS;
	const memberCap = input.memberIterationsCap ?? 200;

	const summaryPositions = layoutSummaryTier(
		summaryNodes,
		summaryLinks,
		summaryIterations,
	);
	// Render-scale overview pass (tm #1080) — same test hook: 0 iterations
	// skips ticks and yields the pure scaled world seed.
	const overviewPositions = layoutOverviewTier(
		summaryNodes,
		summaryLinks,
		summaryPositions,
		summaryIterations,
	);

	// NaN-fill so coverage is PROVABLE — (0,0) is a legitimate position, an
	// untouched slot is not. The final sweep parks any survivor + counts it.
	const nodeX = new Float64Array(slice.ids.length).fill(Number.NaN);
	const nodeY = new Float64Array(slice.ids.length).fill(Number.NaN);
	let forceLaidOut = 0;
	let phyllotaxisLaidOut = 0;
	let warmStarted = 0;

	// Communities with a super-node (size ≥ 2) — local layout inside the disc.
	const communityById = new Map<number, PositionSummaryNode>();
	for (const s of summaryNodes) {
		if (s.kind === "community" && s.communityId !== undefined) {
			communityById.set(s.communityId, s);
		}
	}
	// Time-budgeted event-loop yields (re-review finding): a count-based
	// cadence lets a run of large sub-sims block for seconds; checking elapsed
	// time after EVERY community keeps the serving container responsive no
	// matter how the sizes distribute.
	let lastYield = Date.now();
	for (const [communityId, idxs] of members) {
		const summary = communityById.get(communityId);
		if (!summary || idxs.length < 2) continue;
		const center = summaryPositions.get(summary.id);
		if (!center) continue;
		const ranked = rankMembers(slice, idxs);
		if (ranked.length <= FORCE_COMMUNITY_MAX) {
			const iterations = Math.min(
				memberCap,
				Math.round(40 + 2 * Math.sqrt(ranked.length) * 8),
			);
			warmStarted += layoutCommunityForce(
				slice,
				ranked,
				center,
				iterations,
				input.priorPositions,
				nodeX,
				nodeY,
			);
			forceLaidOut += ranked.length;
		} else {
			layoutCommunityPhyllotaxis(ranked, center, nodeX, nodeY);
			phyllotaxisLaidOut += ranked.length;
		}
		if (Date.now() - lastYield > YIELD_BUDGET_MS) {
			await yieldToLoop();
			lastYield = Date.now();
		}
	}

	// Louvain singletons — placed in their label bucket's disc, deterministic
	// order (elementId asc) so the same node set always lands identically.
	const bucketMembers = new Map<string, number[]>();
	for (const [, idxs] of members) {
		if (idxs.length !== 1) continue;
		const idx = idxs[0] as number;
		const li = slice.labelIdx[idx] ?? -1;
		const label = li >= 0 ? (COMPUTE_LABELS[li] as string) : "Unknown";
		const key = `label-bucket-${label}`;
		const list = bucketMembers.get(key) ?? [];
		list.push(idx);
		bucketMembers.set(key, list);
	}
	for (const [bucketId, idxs] of bucketMembers) {
		const center = summaryPositions.get(bucketId);
		if (!center) {
			// Bucket absent from the summary tier (shouldn't happen — the writer
			// builds both from the same partition) — park the members near origin
			// rather than losing coverage.
			for (const idx of idxs) {
				const p = hashDiscPoint(
					slice.ids[idx] ?? String(idx),
					NODE_SPACING * 6,
				);
				nodeX[idx] = p.x;
				nodeY[idx] = p.y;
			}
			phyllotaxisLaidOut += idxs.length;
			continue;
		}
		// Hash placement, NOT rank phyllotaxis: bucket membership churns weekly
		// (every new Currency/Star/… singleton) and rank-indexed spirals would
		// re-scatter the entire tail on each membership change.
		for (const idx of idxs) {
			const p = hashDiscPoint(slice.ids[idx] ?? String(idx), center.r * 0.9);
			nodeX[idx] = center.x + p.x;
			nodeY[idx] = center.y + p.y;
		}
		phyllotaxisLaidOut += idxs.length;
	}

	// Defensive final sweep: anything neither pass reached parks on an
	// origin ring instead of shipping NaN into the DB.
	let unpositioned = 0;
	for (let i = 0; i < nodeX.length; i++) {
		if (Number.isNaN(nodeX[i]) || Number.isNaN(nodeY[i])) {
			const p = phyllotaxisPoint(unpositioned, 64, NODE_SPACING * 6);
			nodeX[i] = p.x;
			nodeY[i] = p.y;
			unpositioned++;
		}
	}

	return {
		nodeX,
		nodeY,
		summaryPositions,
		overviewPositions,
		forceLaidOut,
		phyllotaxisLaidOut,
		unpositioned,
		warmStarted,
		wallMs: Date.now() - t0,
	};
}
