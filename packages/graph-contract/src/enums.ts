/**
 * Closed vocabularies — honesty as types (DESIGN-V2 §2).
 *
 * These enums are deliberately CLOSED. Extending one is a contract-version
 * event, not a convenience edit: the absence of certain members IS the
 * enforcement (no balance measure, no "settled/final/PvP" state).
 */

/**
 * Provenance is required on every node and edge — honesty reaches the UI by
 * construction (engine law 16: a data-bearing lens without visible
 * real/illustrative state is a test failure).
 */
export const PROVENANCES = [
	"real",
	"illustrative",
	"stale",
	"unmeasured",
] as const;
export type Provenance = (typeof PROVENANCES)[number];

/**
 * What a quantitative field MEANS (codex finding 7). There is intentionally
 * NO member for balances or holdings: Florin balances and member-to-member
 * amounts can never enter a payload because no field can carry them
 * (engine law 17 — confidential-by-design). `volume-usd-observed` is
 * observed public flow (USDC-in / settlement records), never a held balance.
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
 * Settlement-ish states (codex finding 16). No member says settled, final,
 * atomic, or PvP — "proof-of-funds recorded on-chain; finality is the
 * chain's" is the only honest claim, and UI copy renders from this enum via
 * the grammar. A freeform settlement status string is a serializer error.
 */
export const SETTLEMENT_STATES = [
	"proof-of-funds-recorded",
	"route-executed",
	"partner-reported",
	"chain-confirmed",
] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/**
 * Token layer is a TYPE, not a color (codex finding 15;
 * .claude/rules/token-layer-distinction.md). A lens declares which layers it
 * may include; mixing position + settlement layers requires explicit
 * declaration and is display-side-by-side, never conversion.
 */
export const TOKEN_LAYERS = [
	"fxyz-position",
	"florin-settlement",
	"joule",
	"how",
] as const;
export type TokenLayer = (typeof TOKEN_LAYERS)[number];

/**
 * Data roles bind color to meaning via the locked Bloomberg accent tokens
 * (`--fx-role-*`, decision-lock). Role, never route.
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
 * Canon statuses a rendered node may carry (subset of the 9-value write-side
 * enum in canon-write-discipline; renderers only ever see these).
 */
export const CANON_STATUSES = [
	"active",
	"proposal",
	"contested",
	"awaiting_grounding",
	"superseded",
] as const;
export type CanonStatus = (typeof CANON_STATUSES)[number];
