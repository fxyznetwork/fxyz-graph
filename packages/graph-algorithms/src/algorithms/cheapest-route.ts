/**
 * Cheapest route — the FX-family first-proof.
 *
 * Minimum-cost path via Bellman-Ford over additive edge weights. For FX the
 * weight is -ln(rate), so the minimum-weight path is the maximum-compounded-rate
 * conversion, and `meta.compoundedRate = exp(-totalWeight)`. Bellman-Ford (not
 * Dijkstra) because FX weights can be negative once spreads/incentives apply.
 * This algorithm returns a single best PATH only — negative-cycle (arbitrage)
 * detection is the sibling `negative-cycles` registry row (negative-cycles.ts),
 * which shares this file's `edgeCost` weight convention.
 *
 * A server-side implementation of the same logic (`rateToWeight` +
 * `bellmanFord` over live FX rate data in Neo4j) can run as a `server-cypher`
 * venue. This adapter is the pure, dependency-free re-expression over the
 * generic `SubGraph`, so the SAME routing logic is one registry row a
 * `client-ts` venue can run on the loaded working set. It shares the
 * algorithm, not the code (no neo4j import).
 *
 * Sibling demonstration: this `fx-routing` row and the `centrality` row live in
 * ONE registry under ONE `run(workingSet, params) => Promise<AlgoResult>`
 * contract. FX and graph algorithms are siblings, never "is it blocked."
 */

import type {
	AlgoPath,
	AlgoResult,
	Algorithm,
	GraphEdge,
	NodeId,
	SubGraph,
} from "../types";

export interface CheapestRouteParams {
	source: NodeId;
	target: NodeId;
}

/**
 * Additive cost of an edge: explicit weight, else -ln(rate) (FX), else unusable.
 * Exported so sibling algorithms (negative-cycles) share the SAME weight
 * convention instead of re-deriving it.
 */
export function edgeCost(edge: GraphEdge): number | null {
	if (typeof edge.weight === "number" && Number.isFinite(edge.weight)) {
		return edge.weight;
	}
	const rate = edge.properties?.rate;
	if (typeof rate === "number" && rate > 0) return -Math.log(rate);
	return null;
}

/** Bellman-Ford SSSP from `source`, reconstructing the path to `target`. */
function bellmanFord(
	graph: SubGraph,
	source: NodeId,
	target: NodeId,
): AlgoPath | null {
	const present = new Set(graph.nodes.map((n) => n.id));
	if (!present.has(source) || !present.has(target)) return null;

	const usable = graph.edges
		.map((e) => ({ edge: e, cost: edgeCost(e) }))
		.filter((x): x is { edge: GraphEdge; cost: number } => x.cost !== null);

	const dist = new Map<NodeId, number>();
	const prev = new Map<NodeId, { node: NodeId; edge: GraphEdge }>();
	for (const id of present) dist.set(id, Number.POSITIVE_INFINITY);
	dist.set(source, 0);

	// |V|-1 relaxation passes; early-exit once a pass changes nothing.
	for (let pass = 0; pass < present.size - 1; pass++) {
		let changed = false;
		for (const { edge, cost } of usable) {
			const du = dist.get(edge.source);
			if (du === undefined || du === Number.POSITIVE_INFINITY) continue;
			const alt = du + cost;
			if (alt < (dist.get(edge.target) ?? Number.POSITIVE_INFINITY)) {
				dist.set(edge.target, alt);
				prev.set(edge.target, { node: edge.source, edge });
				changed = true;
			}
		}
		if (!changed) break;
	}

	const total = dist.get(target);
	if (total === undefined || total === Number.POSITIVE_INFINITY) return null;

	// Reconstruct source → target (guarding against a pathological loop).
	const nodes: NodeId[] = [];
	const edges: GraphEdge[] = [];
	const seen = new Set<NodeId>();
	let cur: NodeId | undefined = target;
	while (cur !== undefined) {
		nodes.unshift(cur);
		if (cur === source) break;
		if (seen.has(cur)) return null;
		seen.add(cur);
		const step = prev.get(cur);
		if (!step) return null;
		edges.unshift(step.edge);
		cur = step.node;
	}

	return {
		nodes,
		edges,
		totalWeight: total,
		meta: { compoundedRate: Math.exp(-total), hops: edges.length },
	};
}

export const cheapestRoute: Algorithm<CheapestRouteParams> = {
	id: "cheapest-route",
	family: "fx-routing",
	title: "Cheapest route",
	description:
		"Minimum-cost path via Bellman-Ford. For FX the weight is -ln(rate), so the " +
		"result is the best-compounded conversion (meta.compoundedRate). Negative " +
		'weights are allowed; for arbitrage-loop detection use the sibling "negative-cycles" algorithm.',
	paramSchema: {
		source: { kind: "nodeId", label: "From", required: true },
		target: { kind: "nodeId", label: "To", required: true },
	},
	venues: ["client-ts", "server-cypher"],
	maxWorkingSet: { "client-ts": 20_000 },
	defaultEncodingChannel: "foreground",
	resultKind: "paths",
	run: async (workingSet, params): Promise<AlgoResult> => {
		const path = bellmanFord(workingSet, params.source, params.target);
		return { kind: "paths", paths: path ? [path] : [] };
	},
};
