/**
 * Deterministic 2D close layout for a 3D→2D crossfade.
 *
 * The 2D positions must encode TOPOLOGY (adjacency-as-proximity — hub-spoke
 * stars must read as stars) while staying DETERMINISTIC (same input → same
 * output, no live physics at consume time), and the crossfade must land on a
 * shape that visibly descends from the 3D layout.
 *
 * How each property is met:
 *   - Continuity: the sim is INITIALIZED from the 3D pass's (x, y) — the same
 *     projection a renderer crossfades from — so the relaxation reorganizes the
 *     shape already on screen instead of teleporting nodes into category discs.
 *   - Adjacency: a link force over the real slice edges pulls neighbors
 *     together; d3's default per-link strength (1/min-degree) lets hubs hold
 *     many short spokes without collapsing.
 *   - Density-as-information: a collision force sized by degree prevents overlap
 *     but does NOT normalize spacing — clusters stay dense, whitespace stays empty.
 *   - Determinism: fixed iteration count, run-to-completion synchronous tick
 *     loop, deterministic initial positions, and d3-force-3d's default seeded
 *     random source (used only for coincident-point jiggle). Same slice in →
 *     identical positions out, across processes.
 *
 * Degree-0 nodes are EXCLUDED from the sim entirely — their absence from the
 * returned map is the unambiguous "isolated" signal (no close2d ⇒ excluded).
 *
 * Runs server-side in buildLandingSlice (same place as the 3D pass). Bounded:
 * fixed ticks, no async, no timers — cache the slice if you rebuild it often.
 */

// d3-force-3d ships its own .d.ts so no @types/* needed
import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
} from "d3-force-3d";
import type { SubstrateEdge } from "../types";
import type { PositionedNode } from "./types";

interface CloseLayoutArgs {
	/** Substrate-positioned nodes (output of the 3D pass — x/y seed the sim). */
	nodes: PositionedNode[];
	/** Slice edges (real + synthesized). Drive the link force. */
	edges: SubstrateEdge[];
	/**
	 * Fixed tick count. Default 120 — the alphaDecay schedule anneals to the
	 * same 0.001 alpha floor regardless of count, so more ticks buy almost
	 * no quality (measured: top-hub neighbor capture 73-74% from 90 through
	 * 240 ticks) while runtime scales linearly (~4ms/tick at ~900 nodes).
	 */
	iterations?: number;
}

interface CloseSimNode {
	id: string;
	x: number;
	y: number;
	degree: number;
}

interface CloseSimLink {
	source: string;
	target: string;
	/** True when either endpoint is degree-1 — a spoke, kept short. */
	spoke: boolean;
}

/**
 * Collision base radius in layout world units. The 3D pass spreads the
 * slice over roughly ±70 world units; ~900 in-sim nodes at base ~1.0 keep
 * local overlap impossible while leaving the global density gradient intact.
 */
const COLLIDE_BASE = 1.0;
/** Spoke (leaf→hub) target length — tight ego stars. */
const SPOKE_DISTANCE = 2.4;
/** Hub↔hub / mid-degree span target length — visible inter-star spans. */
const SPAN_DISTANCE = 7;
/** Weak gravity toward origin so disconnected components stay framed. */
const GRAVITY_STRENGTH = 0.04;

/**
 * Run the deterministic 2D close layout.
 *
 * Returns a Map nodeId → [x, y] (rounded to 2 decimals) containing ONLY
 * nodes with degree ≥ 1. Degree-0 dust is absent by design.
 */
export function runCloseLayout2d({
	nodes,
	edges,
	iterations = 120,
}: CloseLayoutArgs): Map<string, [number, number]> {
	const degree = new Map<string, number>();
	for (const edge of edges) {
		degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
		degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
	}

	const simNodes: CloseSimNode[] = [];
	for (const node of nodes) {
		const d = degree.get(node.id) ?? 0;
		if (d === 0) continue; // dust — excluded, see module doc
		simNodes.push({ id: node.id, x: node.x, y: node.y, degree: d });
	}
	const out = new Map<string, [number, number]>();
	if (simNodes.length === 0) return out;

	const inSim = new Set(simNodes.map((n) => n.id));
	const simLinks: CloseSimLink[] = [];
	for (const edge of edges) {
		if (!inSim.has(edge.source) || !inSim.has(edge.target)) continue;
		const spoke =
			(degree.get(edge.source) ?? 0) === 1 ||
			(degree.get(edge.target) ?? 0) === 1;
		simLinks.push({ source: edge.source, target: edge.target, spoke });
	}

	let maxDegree = 1;
	for (const n of simNodes) {
		if (n.degree > maxDegree) maxDegree = n.degree;
	}

	const simulation = forceSimulation(simNodes, 2)
		.force(
			"link",
			forceLink<CloseSimNode, CloseSimLink>(simLinks)
				.id((n) => n.id)
				// Spokes stay short (ego stars); spans stay readable. Per-link
				// strength is left at d3's default 1 / min(degree) — exactly the
				// hub-friendly weighting that makes star arms settle evenly.
				.distance((link) =>
					(link as CloseSimLink).spoke ? SPOKE_DISTANCE : SPAN_DISTANCE,
				),
		)
		// theta 1.2 = coarser Barnes-Hut approximation — ~30% faster than the
		// 0.9 default with no measurable hub-capture loss (74% vs 73%).
		.force("charge", forceManyBody().strength(-4).distanceMax(30).theta(1.2))
		.force(
			"collide",
			forceCollide<CloseSimNode>(
				// Degree-scaled — matches the consumer's overviewSize shape
				// (base · (1 + 0.5·√(deg/max))) so render-big nodes get room.
				(n) => COLLIDE_BASE * (1 + 0.5 * Math.sqrt(n.degree / maxDegree)),
			).strength(0.9),
		)
		.force("x", forceX<CloseSimNode>(0).strength(GRAVITY_STRENGTH))
		.force("y", forceY<CloseSimNode>(0).strength(GRAVITY_STRENGTH))
		.alpha(1)
		.alphaDecay(1 - 0.001 ** (1 / iterations))
		.stop();

	for (let i = 0; i < iterations; i++) {
		simulation.tick();
	}

	for (const n of simNodes) {
		out.set(n.id, [Math.round(n.x * 100) / 100, Math.round(n.y * 100) / 100]);
	}
	return out;
}
