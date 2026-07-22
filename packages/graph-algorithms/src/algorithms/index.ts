/**
 * The built-in algorithms.
 *
 * One row from each side of the old false divide — a graph algorithm
 * (`eigenvector-centrality`, `centrality` family) and an FX algorithm
 * (`cheapest-route`, `fx-routing` family) — plus `negative-cycles` (`cycle`
 * family), the producer for the `cycles` result kind. They are siblings in ONE
 * registry under ONE contract — the proof that "adding an analytic is adding a
 * row."
 */

import type { Algorithm } from "../types";
import { cheapestRoute } from "./cheapest-route";
import { eigenvectorCentrality } from "./eigenvector-centrality";
import { negativeCycles } from "./negative-cycles";

export type { CheapestRouteParams } from "./cheapest-route";
export { cheapestRoute, edgeCost } from "./cheapest-route";
export type { EigenvectorParams } from "./eigenvector-centrality";
export { eigenvectorCentrality } from "./eigenvector-centrality";
export type { NegativeCyclesParams } from "./negative-cycles";
export { negativeCycles } from "./negative-cycles";

/** The built-in algorithm rows, ready to `registerAll`. */
export const BUILTIN_ALGORITHMS: ReadonlyArray<Algorithm<any>> = [
	eigenvectorCentrality,
	cheapestRoute,
	negativeCycles,
];
