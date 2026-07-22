/**
 * Deterministic edge ids for the v0 slice identity space, in the
 * @fxyz/graph-contract EdgeId grammar (refs.ts makeEdgeId):
 *
 *   edge:{type}:{source}→{target}[:{discriminator}]
 *
 * v0 slice keys are pre-ref (no `kind:` prefix — "USD", "brazil", concept
 * ids), so the typed contract maker can't be used yet without lying about
 * ref-ness. Grammar parity with makeEdgeId is locked by edge-id.test.ts;
 * the contract-native v1 slice replaces this with makeEdgeId over real
 * GraphRefs (tm #1003).
 *
 * Replaces the deprecated Neo4j `id(r)` integer key (least-durable scheme
 * in the estate — values change on any DB restore/repopulation). These ids
 * are stable across refetches for the same logical edge; parallel edges of
 * the same type between the same endpoints collapse to one id, so mappers
 * MUST dedupe on it (the v0 slice carries no per-edge properties, so the
 * duplicates carried no information).
 */
export function sliceEdgeId(
	type: string,
	source: string,
	target: string,
	discriminator?: string,
): string {
	const base = `edge:${type.trim()}:${source}→${target}`;
	return discriminator ? `${base}:${discriminator.trim()}` : base;
}
