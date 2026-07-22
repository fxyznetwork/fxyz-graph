/**
 * The venue resolver — this is the layer that ends "blocked."
 *
 * The old plan modeled heavy analytics as a BLOCKED state ("needs Memgraph
 * MAGE / locked-out GDS"). That was a category error: it conflated "the GDS
 * plugin isn't installed" with "this algorithm is impossible." Under this
 * architecture, where an algorithm runs is a DERIVED field chosen per-call from
 * the measured working-set size — never a capability gate.
 *
 * `deriveVenue` picks from the venues an algorithm DECLARES it can run in,
 * honoring each venue's size envelope, and REFUSES out-of-envelope selections
 * (e.g. a whole-graph PageRank routed to the browser) by returning a "refused"
 * decision instead of letting the caller hang the tab. A refusal is the
 * caller's signal to collapse-to-super-nodes or queue a precompute — never a
 * silent failure.
 */

import type { Algorithm, Venue } from "./types";

export interface VenueDecision {
	/** The chosen venue, or null when no declared venue fits the working set. */
	venue: Venue | null;
	/** True when every candidate venue's envelope was exceeded. */
	refused: boolean;
	/** Human-readable rationale (telemetry + "too large, collapse first" UX). */
	reason: string;
}

/**
 * Default size envelopes, used only for venues an algorithm does not pin via
 * `maxWorkingSet`. These are conservative starting points; the NVL/working-set
 * ceiling is genuinely unmeasured (docs disagree 1k/5k/50k/100k), so these are
 * tuned once the /graph FX-lens measurement harness (tm #754) lands. The precompute and GDS
 * venues are unbounded here because they run server-side off the render path.
 */
export const DEFAULT_VENUE_ENVELOPE: Record<Venue, number> = {
	"client-ts": 5_000,
	"server-cypher": 50_000,
	"precomputed-cron": Number.POSITIVE_INFINITY,
	"server-gds": Number.POSITIVE_INFINITY,
};

/**
 * Preference order: cheapest/closest-to-the-render first, heaviest last. The
 * resolver walks the algorithm's declared venues in THIS order and takes the
 * first whose envelope fits the measured count.
 */
const VENUE_PREFERENCE: readonly Venue[] = [
	"client-ts",
	"server-cypher",
	"precomputed-cron",
	"server-gds",
];

export interface DeriveVenueOptions {
	/**
	 * Venues currently AVAILABLE in this deployment. `server-gds` is declared by
	 * algorithms but only becomes selectable once the GDS plugin is installed —
	 * pass the live set here. Defaults to all venues except `server-gds`
	 * (today's reality: NEO4J_PLUGINS=["apoc","n10s"]).
	 */
	availableVenues?: readonly Venue[];
}

const DEFAULT_AVAILABLE: readonly Venue[] = [
	"client-ts",
	"server-cypher",
	"precomputed-cron",
];

/**
 * Pick the execution venue for one algorithm run.
 *
 * @param algorithm     the registry row (declares its candidate venues + envelopes)
 * @param measuredCount the real working-set node count (post-resolution COUNT)
 */
export function deriveVenue(
	algorithm: Algorithm<any>,
	measuredCount: number,
	options: DeriveVenueOptions = {},
): VenueDecision {
	const available = new Set(options.availableVenues ?? DEFAULT_AVAILABLE);

	// Walk preference order, restricted to what this algorithm declares AND what
	// the deployment offers.
	const candidates = VENUE_PREFERENCE.filter(
		(v) => algorithm.venues.includes(v) && available.has(v),
	);

	if (candidates.length === 0) {
		return {
			venue: null,
			refused: true,
			reason: `No venue available for "${algorithm.id}": declares [${algorithm.venues.join(", ")}], deployment offers [${[...available].join(", ")}].`,
		};
	}

	for (const venue of candidates) {
		const envelope =
			algorithm.maxWorkingSet?.[venue] ?? DEFAULT_VENUE_ENVELOPE[venue];
		if (measuredCount <= envelope) {
			return {
				venue,
				refused: false,
				reason: `Selected "${venue}" for "${algorithm.id}" (working set ${measuredCount} ≤ ${envelope}).`,
			};
		}
	}

	// Every candidate's envelope was exceeded — refuse rather than hang.
	const largest = candidates[candidates.length - 1];
	const largestEnvelope =
		algorithm.maxWorkingSet?.[largest] ?? DEFAULT_VENUE_ENVELOPE[largest];
	return {
		venue: null,
		refused: true,
		reason: `Working set ${measuredCount} exceeds every available venue envelope for "${algorithm.id}" (largest "${largest}" = ${largestEnvelope}). Collapse to super-nodes or queue a precompute.`,
	};
}
