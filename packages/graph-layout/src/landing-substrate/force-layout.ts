/**
 * Force-directed 3D layout for the landing graph slice.
 *
 * Pure function — runs server-side at API time so the response carries
 * pre-computed positions. The R3F renderer reads the positions and applies
 * subtle continuous motion (Brownian breath, lens-shift) on top.
 *
 * Algorithm:
 *   - 3D force simulation (`d3-force-3d`) with link, charge, center, and
 *     community-cohesion forces
 *   - Communities pull their members inward (cluster cohesion) so each cluster
 *     reads as a distinct region
 *   - Inter-community edges still pull (when present) but at lower strength
 *     so subgraphs stay readable as separate
 *
 * Determinism:
 *   - Seeded initial positions via a hash of the node id
 *   - Fixed iteration count (300 ticks) for stable output across requests
 */

// d3-force-3d ships its own .d.ts so no @types/* needed
import {
	forceCenter,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	forceZ,
} from "d3-force-3d";
import type { SubstrateEdge, SubstrateNode } from "../types";
import type { PaletteTone, PositionedNode } from "./types";

interface LayoutArgs {
	nodes: SubstrateNode[];
	edges: SubstrateEdge[];
	nodeCommunity: Record<string, string>;
	communityTones: Map<string, PaletteTone>;
	/** World-space radius — how far nodes extend from origin. Default 28. */
	radius?: number;
	/** Force-simulation tick count. Default 300. Higher = more settled. */
	iterations?: number;
}

interface SimNode {
	id: string;
	x: number;
	y: number;
	z: number;
	communityId: string;
}

interface SimLink {
	source: string;
	target: string;
	strength: number;
}

const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * Deterministic seed in [-1, 1] from an arbitrary string. Fast hash, good
 * enough for visual differentiation; avoids needing a crypto/random dep.
 */
function seedScalar(input: string, salt: number): number {
	let hash = 2166136261 ^ salt;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return ((hash >>> 0) / 2 ** 32) * 2 - 1;
}

/**
 * Run the force layout. Returns `PositionedNode[]` with x/y/z + tone.
 *
 * Communities are clustered around their centroid using a soft attractive
 * force (forceX/Y/Z towards the community anchor), strength 0.05 — enough
 * to read as a cluster but not collapse into a point.
 */
export function runForceLayout({
	nodes,
	edges,
	nodeCommunity,
	communityTones,
	radius = 28,
	iterations = 300,
}: LayoutArgs): PositionedNode[] {
	const communities = Array.from(new Set(Object.values(nodeCommunity)));
	const communityAnchors = computeCommunityAnchors(communities, radius);

	const simNodes: SimNode[] = nodes.map((node) => {
		const communityId = nodeCommunity[node.id] ?? "community-orphan";
		const anchor = communityAnchors.get(communityId) ?? { x: 0, y: 0, z: 0 };
		return {
			id: node.id,
			x: anchor.x + seedScalar(node.id, 1) * (radius * 0.18),
			y: anchor.y + seedScalar(node.id, 2) * (radius * 0.18),
			z: anchor.z + seedScalar(node.id, 3) * (radius * 0.18),
			communityId,
		};
	});

	const nodeIds = new Set(simNodes.map((n) => n.id));
	const simLinks: SimLink[] = edges.flatMap((e) => {
		if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) return [];
		const sameCommunity = nodeCommunity[e.source] === nodeCommunity[e.target];
		return [
			{
				source: e.source,
				target: e.target,
				strength: sameCommunity ? 0.6 : 0.2,
			},
		];
	});

	const simulation = forceSimulation(simNodes, 3)
		.force(
			"link",
			forceLink<SimNode, SimLink>(simLinks)
				.id((n) => n.id)
				.distance(2.5)
				.strength((link) => (link as SimLink).strength),
		)
		.force("charge", forceManyBody().strength(-3.5))
		.force("center", forceCenter(0, 0, 0))
		.force(
			"cluster-x",
			forceX<SimNode>(
				(n) => communityAnchors.get(n.communityId)?.x ?? 0,
			).strength(0.05),
		)
		.force(
			"cluster-y",
			forceY<SimNode>(
				(n) => communityAnchors.get(n.communityId)?.y ?? 0,
			).strength(0.05),
		)
		.force(
			"cluster-z",
			forceZ<SimNode>(
				(n) => communityAnchors.get(n.communityId)?.z ?? 0,
			).strength(0.05),
		)
		.alpha(1)
		.alphaDecay(1 - 0.001 ** (1 / iterations))
		.stop();

	for (let i = 0; i < iterations; i++) {
		simulation.tick();
	}

	return simNodes.map((sn, i) => {
		const original = nodes[i];
		if (!original || original.id !== sn.id) {
			throw new Error(
				`force-layout: node order drift between input and simulation at index ${i}`,
			);
		}
		const communityId = sn.communityId;
		const tone = communityTones.get(communityId) ?? "amber";
		return {
			...original,
			x: sn.x,
			y: sn.y,
			z: sn.z,
			communityId,
			tone,
		};
	});
}

/**
 * Place community anchors on a spherical fibonacci lattice — ensures even
 * spacing without overlap regardless of community count. Golden-ratio
 * angular increment (φ).
 */
function computeCommunityAnchors(
	communityIds: string[],
	radius: number,
): Map<string, { x: number; y: number; z: number }> {
	const out = new Map<string, { x: number; y: number; z: number }>();
	const n = communityIds.length;
	if (n === 0) return out;
	const r = radius * 0.55;
	for (let i = 0; i < n; i++) {
		const t = i + 0.5;
		const phi = Math.acos(1 - (2 * t) / n);
		const theta = 2 * Math.PI * PHI * t;
		const x = r * Math.cos(theta) * Math.sin(phi);
		const y = r * Math.sin(theta) * Math.sin(phi);
		const z = r * Math.cos(phi);
		const id = communityIds[i];
		if (id) out.set(id, { x, y, z });
	}
	return out;
}
