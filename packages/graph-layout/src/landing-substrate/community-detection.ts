/**
 * Community detection for the landing substrate.
 *
 * Two-pass scheme:
 *   1. Group by `node.kind` — natural macro-communities (Currency / Concept /
 *      FinancialInstitution / etc.) used for layout clustering.
 *   2. Within each macro-community, run Louvain to find sub-clusters when
 *      the kind has > MIN_FOR_LOUVAIN nodes.
 *
 * The substrate is rendered monochrome (single neutral tone). Per-kind visual
 * emphasis is driven by the active beat in `landing-vnext/scene.tsx` (e.g.
 * `currency` beat highlights Currency nodes), not by a kind→tone palette
 * mapping in this layer. The prior `KIND_TONE` (Concept→florin / Currency→
 * joule / Citation→wisdom / FI→network / Country→earth) was AI-fabricated —
 * no canon backing for kind→tone — and was removed 2026-05-07.
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { SubstrateEdge, SubstrateNode, SubstrateNodeKind } from "../types";
import type { LandingCommunity, StellarTone } from "./types";

/** Single neutral tone for the entire substrate. Beat-driven highlight in
 *  scene.tsx adds emphasis where the story calls for it. */
const SUBSTRATE_TONE: StellarTone = "network";
const SUBSTRATE_COLOR = "#aec2f8";
const SUBSTRATE_STRONG = "#546cb7";

const MIN_FOR_LOUVAIN = 12;

interface DetectArgs {
	nodes: SubstrateNode[];
	edges: SubstrateEdge[];
}

interface DetectResult {
	communities: LandingCommunity[];
	nodeCommunity: Record<string, string>;
}

/**
 * Run two-pass community detection. Returns:
 *   - `communities`: ordered list of resolved communities (kind-anchored,
 *     louvain-subdivided where applicable)
 *   - `nodeCommunity`: map of nodeId → communityId for renderer lookup
 */
export function detectCommunities({ nodes, edges }: DetectArgs): DetectResult {
	const byKind = new Map<SubstrateNodeKind, SubstrateNode[]>();
	for (const node of nodes) {
		const list = byKind.get(node.kind) ?? [];
		list.push(node);
		byKind.set(node.kind, list);
	}

	const communities: LandingCommunity[] = [];
	const nodeCommunity: Record<string, string> = {};

	// TODO(#1003): these community ids are unversioned (no dataVersion), which
	// @fxyz/graph-contract makeCommunityRef exists to prevent. Safe HERE only
	// because landing community ids never leave one build's payload (scene.tsx
	// / glossary-card.tsx key lookups from the same slice; nothing persists
	// them). Landing slice v0 is FROZEN, so values stay; the contract-native
	// v1 slice mints version-qualified community refs. Do NOT persist these
	// ids (saved views, URLs) in any new consumer.

	for (const [kind, kindNodes] of byKind) {
		if (kindNodes.length < MIN_FOR_LOUVAIN) {
			const id = `community-${kind.toLowerCase()}`;
			communities.push({
				id,
				kind,
				size: kindNodes.length,
				tone: SUBSTRATE_TONE,
				color: SUBSTRATE_COLOR,
				strongColor: SUBSTRATE_STRONG,
			});
			for (const node of kindNodes) nodeCommunity[node.id] = id;
			continue;
		}

		const subPartitions = louvainSubPartition(kindNodes, edges);
		for (const [louvainId, subNodes] of subPartitions) {
			const id = `community-${kind.toLowerCase()}-${louvainId}`;
			communities.push({
				id,
				kind,
				louvainId,
				size: subNodes.length,
				tone: SUBSTRATE_TONE,
				color: SUBSTRATE_COLOR,
				strongColor: SUBSTRATE_STRONG,
			});
			for (const node of subNodes) nodeCommunity[node.id] = id;
		}
	}

	return { communities, nodeCommunity };
}

/**
 * Build a graphology graph from the kind-restricted node set + intra-kind
 * edges, then run Louvain. Returns sub-partitions keyed by louvain community
 * id with the original SubstrateNode references.
 */
function louvainSubPartition(
	kindNodes: SubstrateNode[],
	allEdges: SubstrateEdge[],
): Map<number, SubstrateNode[]> {
	const nodeIds = new Set<string>();
	const graph = new Graph({ multi: false, type: "undirected" });
	for (const node of kindNodes) {
		// Defensive: source data has produced nodes with empty/duplicate ids
		// in the wild (KG canon-promotion artefacts). Skip them rather than
		// blowing up the whole landing slice — they collapse into community 0.
		if (!node.id || nodeIds.has(node.id)) continue;
		nodeIds.add(node.id);
		graph.addNode(node.id);
	}
	for (const edge of allEdges) {
		if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
		if (edge.source === edge.target) continue;
		if (graph.hasEdge(edge.source, edge.target)) continue;
		graph.addEdge(edge.source, edge.target);
	}

	if (graph.size === 0) {
		return new Map([[0, kindNodes]]);
	}

	const partition = louvain(graph) as Record<string, number>;
	const out = new Map<number, SubstrateNode[]>();
	for (const node of kindNodes) {
		const cid = partition[node.id] ?? 0;
		const list = out.get(cid) ?? [];
		list.push(node);
		out.set(cid, list);
	}
	return out;
}
