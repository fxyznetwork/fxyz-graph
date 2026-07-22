/**
 * Deterministic edge ids for the slice identity space, byte-compatible with the
 * @fxyz/graph-contract EdgeId grammar (refs.ts makeEdgeId):
 *
 *   edge:{type}:{source}→{target}[:{discriminator}]
 *
 * Slice keys are bare strings ("USD", "brazil", concept ids) rather than typed
 * GraphRefs, so this local maker is used instead of the typed contract one;
 * grammar parity with makeEdgeId is locked by edge-id.test.ts.
 *
 * These ids are stable across refetches for the same logical edge. Parallel
 * edges of the same type between the same endpoints collapse to one id, so
 * mappers MUST dedupe on it.
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
