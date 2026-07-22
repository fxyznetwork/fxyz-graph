/**
 * Eigenvector centrality — the graph-family first-proof.
 *
 * A node is central if its neighbours are central. Power iteration on the
 * (undirected) working set surfaces the "money-center" hubs whose failure
 * cascades beyond direct exposure — the same metric the Fedwire core-periphery
 * decomposition uses (Bonacich 1972; Soramäki, Bech, Arnold, Glass, Beyeler,
 * "The Topology of Interbank Payment Flows," Physica A 379, 2007).
 *
 * The same computation can run over a bilateral-flow matrix in a money-flow
 * visualization layer. This adapter is the pure, dependency-free
 * re-expression over the generic `SubGraph` so the SAME metric is one
 * registry row instead of one bespoke computation per consumer. It
 * does not import any rendering layer (that would couple this package to a
 * specific consumer); it shares the algorithm, not the code.
 */

import type { AlgoResult, Algorithm, NodeId, SubGraph } from "../types";

export interface EigenvectorParams {
	/** Max power-iteration steps. Converges in ~25 at country scale. */
	maxIterations?: number;
	/** L2 residual convergence threshold. */
	tolerance?: number;
}

const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_TOLERANCE = 1e-6;

/** Power iteration over the undirected weighted working set → [0,1] scores. */
function computeScores(
	graph: SubGraph,
	maxIterations: number,
	tolerance: number,
): Map<NodeId, number> {
	const n = graph.nodes.length;
	const scores = new Map<NodeId, number>();
	if (n === 0) return scores;

	const index = new Map<NodeId, number>();
	graph.nodes.forEach((node, i) => index.set(node.id, i));

	// Sparse undirected adjacency as parallel arrays (skip self-loops + danglers).
	const srcIdx: number[] = [];
	const dstIdx: number[] = [];
	const weights: number[] = [];
	for (const edge of graph.edges) {
		const i = index.get(edge.source);
		const j = index.get(edge.target);
		if (i === undefined || j === undefined || i === j) continue;
		const w =
			typeof edge.weight === "number" && edge.weight > 0 ? edge.weight : 1;
		srcIdx.push(i);
		dstIdx.push(j);
		weights.push(w);
	}

	// No edges → no influence flow → all zero (intuitive: nothing lights up).
	if (weights.length === 0) {
		for (const node of graph.nodes) scores.set(node.id, 0);
		return scores;
	}

	let v = new Array<number>(n).fill(1 / Math.sqrt(n));
	let next = new Array<number>(n).fill(0);

	// Iterate v ← (A + I)·v, not A·v: the +I (self-reinforcement) shift breaks the
	// ±λ oscillation plain power iteration suffers on bipartite graphs (a star, or a
	// Concept↔Currency subgraph) while leaving the ranking unchanged on the
	// non-bipartite graphs where plain iteration already converges.
	for (let iter = 0; iter < maxIterations; iter++) {
		for (let k = 0; k < n; k++) next[k] = v[k];
		for (let e = 0; e < weights.length; e++) {
			const i = srcIdx[e];
			const j = dstIdx[e];
			const w = weights[e];
			next[i] += w * v[j];
			next[j] += w * v[i];
		}

		let norm = 0;
		for (let k = 0; k < n; k++) norm += next[k] * next[k];
		norm = Math.sqrt(norm);
		if (norm < 1e-12) break; // null matrix — bail
		const inv = 1 / norm;

		let residual = 0;
		for (let k = 0; k < n; k++) {
			next[k] *= inv;
			const d = next[k] - v[k];
			residual += d * d;
		}

		const tmp = v;
		v = next;
		next = tmp;

		if (Math.sqrt(residual) < tolerance) break;
	}

	// Normalize to [0,1] (max = 1) for direct brightness/size encoding.
	let max = 0;
	for (let k = 0; k < n; k++) if (v[k] > max) max = v[k];
	graph.nodes.forEach((node, i) => {
		scores.set(node.id, max > 0 ? v[i] / max : 0);
	});
	return scores;
}

export const eigenvectorCentrality: Algorithm<EigenvectorParams> = {
	id: "eigenvector-centrality",
	family: "centrality",
	title: "Eigenvector centrality",
	description:
		"Influence-flow centrality via power iteration on the undirected working set. " +
		"Surfaces money-center hubs whose failure cascades beyond direct exposure " +
		"(Bonacich 1972; Soramäki et al. 2007).",
	paramSchema: {
		maxIterations: {
			kind: "number",
			label: "Max iterations",
			default: DEFAULT_MAX_ITERATIONS,
			min: 1,
			max: 1000,
		},
		tolerance: {
			kind: "number",
			label: "Convergence tolerance",
			default: DEFAULT_TOLERANCE,
			min: 0,
		},
	},
	venues: ["client-ts", "precomputed-cron", "server-gds"],
	maxWorkingSet: { "client-ts": 20_000 },
	defaultEncodingChannel: "brightness",
	resultKind: "scores",
	run: async (workingSet, params): Promise<AlgoResult> => {
		const values = computeScores(
			workingSet,
			params.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			params.tolerance ?? DEFAULT_TOLERANCE,
		);
		return { kind: "scores", values };
	},
};
