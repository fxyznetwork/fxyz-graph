/**
 * Community detection for the landing graph slice.
 *
 * Two-pass scheme:
 *   1. Group by `node.kind` — natural macro-communities (Currency / Concept /
 *      FinancialInstitution / etc.) used for layout clustering.
 *   2. Within each macro-community, run Louvain to find sub-clusters when
 *      the kind has > MIN_FOR_LOUVAIN nodes.
 *
 * The slice is coloured with a single neutral tone by default; a renderer can
 * add per-kind emphasis on top (e.g. highlighting Currency nodes) rather than
 * baking a kind→tone mapping into this layer.
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { SubstrateEdge, SubstrateNode, SubstrateNodeKind } from "../types";
import type { LandingCommunity, PaletteTone } from "./types";

/** Single neutral tone for the entire slice. A renderer can add emphasis on
 *  top where it wants to draw attention. */
const SUBSTRATE_TONE: PaletteTone = "blue";
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

	// NOTE: these community ids are unversioned (no dataVersion). That is safe
	// only because landing community ids never leave one build's payload — the
	// renderer's key lookups come from the same slice and nothing persists
	// them. Do NOT persist these ids (saved views, URLs) in any new consumer;
	// for a durable community reference, mint a version-qualified id upstream.

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
		// Defensive: source data can contain nodes with empty/duplicate ids.
		// Skip them rather than blowing up the whole slice — they collapse
		// into community 0.
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
