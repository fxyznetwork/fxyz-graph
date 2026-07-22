/**
 * Workbench edge-cache codec (tm #1099 / #1134) — the wire contract between
 * the Louvain precompute (writer) and /api/graph/workbench (reader).
 *
 * Its OWN dep-free module: the reader must never have to import the full
 * precompute engine (graphology / d3-force-3d / neo4j-driver) to decode a
 * 20-line JSON format — that coupling is what kept the API-side read
 * untested until the #1134 outage. precompute-louvain-core re-exports these
 * so the existing `@fxyz/graph-layout/precompute-louvain` surface is intact.
 */

/** Wire shape of one decoded workbench edge (tm #1099). */
export interface WorkbenchCacheEdge {
	sourceEid: string;
	targetEid: string;
	type: string;
	weight: number | null;
}

/** The slice fields the encoder needs (structural subset of the engine's
 *  Slice — indexes in `typedEdges` reference `ids`/`edgeTypes`). */
export interface WorkbenchEdgeCacheSource {
	/** index → Neo4j elementId. */
	ids: string[];
	/** Directed typed edges, deduped by (s,t,type); indexes into `ids`. */
	typedEdges?: Array<[number, number, number, number | null]>;
	/** Edge-type dictionary for typedEdges' third column. */
	edgeTypes?: string[];
}

/**
 * Encode the slice's typed edge set for the :WorkbenchEdgeCache singleton —
 * idx-referenced against the eid array + a type dictionary so the JSON stays
 * a few MB instead of tens (eids are ~40-char strings).
 */
export function encodeWorkbenchEdgeCache(slice: WorkbenchEdgeCacheSource): {
	payload: string;
	edgeCount: number;
} {
	const edges = slice.typedEdges ?? [];
	return {
		payload: JSON.stringify({
			v: 1,
			eids: slice.ids,
			types: slice.edgeTypes ?? [],
			edges,
		}),
		edgeCount: edges.length,
	};
}

/** Decode a :WorkbenchEdgeCache payload (the API route's read half). */
export function decodeWorkbenchEdgeCache(
	payload: string,
): WorkbenchCacheEdge[] {
	const parsed = JSON.parse(payload) as {
		v: number;
		eids: string[];
		types: string[];
		edges: Array<[number, number, number, number | null]>;
	};
	if (parsed.v !== 1) return [];
	const out: WorkbenchCacheEdge[] = [];
	for (const [s, t, ti, w] of parsed.edges) {
		const sourceEid = parsed.eids[s];
		const targetEid = parsed.eids[t];
		const type = parsed.types[ti];
		if (!sourceEid || !targetEid || !type) continue;
		out.push({ sourceEid, targetEid, type, weight: w });
	}
	return out;
}
