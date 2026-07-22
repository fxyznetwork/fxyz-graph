/**
 * Closed vocabularies — honesty as types.
 *
 * These enums are deliberately CLOSED. Extending one is a contract-version
 * event, not a convenience edit: the absence of certain members IS the
 * enforcement (no balance measure, no "settled/final/atomic" state).
 */

/**
 * Provenance is required on every node and edge — honesty reaches the UI by
 * construction: a data-bearing lens without a visible real/illustrative state
 * is a test failure.
 */
export const PROVENANCES = [
	"real",
	"illustrative",
	"stale",
	"unmeasured",
] as const;
export type Provenance = (typeof PROVENANCES)[number];

/**
 * What a quantitative field MEANS. There is intentionally NO member for
 * balances or holdings: a private balance or a person-to-person amount can
 * never enter a payload because no field can carry it (confidential-by-design).
 * `volume-usd-observed` is observed public flow (settlement records), never a
 * held balance.
 */
export const MEASURE_KINDS = [
	"count",
	"degree",
	"rate",
	"cost-bps",
	"volume-usd-observed",
	"capacity",
	"score",
	"magnitude",
	"freshness",
] as const;
export type MeasureKind = (typeof MEASURE_KINDS)[number];

/**
 * Settlement-ish states. No member claims settled, final, or atomic —
 * "proof-of-funds recorded on-chain; finality is the chain's" is the only
 * honest claim, and UI copy renders from this enum. A freeform settlement
 * status string is a serializer error.
 */
export const SETTLEMENT_STATES = [
	"proof-of-funds-recorded",
	"route-executed",
	"partner-reported",
	"chain-confirmed",
] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/**
 * Token layer is a TYPE, not a color. A lens declares which layers it may
 * include; mixing layers of different types requires explicit declaration and
 * is displayed side-by-side, never converted. These are example layers —
 * replace them with your own domain's if you fork.
 */
export const TOKEN_LAYERS = [
	"position",
	"settlement",
	"work",
	"knowledge",
] as const;
export type TokenLayer = (typeof TOKEN_LAYERS)[number];

/**
 * Data roles bind color to meaning (a role-based accent scheme) — color tracks
 * what a node IS, not which page it appears on.
 */
export const DATA_ROLES = [
	"money",
	"flow",
	"governance",
	"topology",
	"compliance",
] as const;
export type DataRole = (typeof DATA_ROLES)[number];

/**
 * Editorial statuses a rendered node may carry — the read-side subset of a
 * fuller editorial-status set a producer might track.
 */
export const NODE_STATUSES = [
	"active",
	"proposal",
	"contested",
	"pending",
	"superseded",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];
