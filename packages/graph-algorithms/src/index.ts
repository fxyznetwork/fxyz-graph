/**
 * @fxyz/graph-algorithms — the first-class, venue-agnostic algorithm layer.
 *
 * One typed registry where FX algorithms (routing, arbitrage) and graph
 * algorithms (centrality, community, pathfinding) are siblings under a uniform
 * `run(workingSet, params) => Promise<AlgoResult>` contract. Pure and
 * dependency-light, so the SAME row is importable by the server resolver and
 * the client engine; where it runs is a per-call `Venue` decision (see
 * `deriveVenue`), never a "blocked" capability gate.
 *
 * The encoding bridge (result → visual channels) is a separate entry:
 * `@fxyz/graph-algorithms/contract`.
 */

export * from "./algorithms";
export * from "./registry";
export * from "./types";
export * from "./venue";

import { BUILTIN_ALGORITHMS } from "./algorithms";
import {
	type AlgorithmRegistry,
	createRegistry,
	type RegistryOptions,
} from "./registry";

/**
 * A registry preloaded with the built-in algorithms. The defaults carry no
 * `groundingConceptId`, so no `GroundingChecker` is required; pass one anyway
 * if you intend to also register ƒxyz-coined metrics.
 */
export function createDefaultRegistry(
	options: RegistryOptions = {},
): AlgorithmRegistry {
	return createRegistry(options).registerAll(BUILTIN_ALGORITHMS);
}
