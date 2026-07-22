/**
 * @fxyz/graph-contract — the identity/payload contract every graph layer
 * signs. Zero runtime dependencies.
 *
 * Consumed by: server-side resolvers, @fxyz/graph-engine (client), and any
 * other rendering layer that needs to agree on node identity — the landing
 * slice builder among them. Nothing above this contract may fork node
 * identity again.
 */

export {
	DEFAULT_TIER_BUDGETS,
	type ProvenancedNumber,
	type TierBudgets,
} from "./budgets";

export {
	CANON_STATUSES,
	type CanonStatus,
	DATA_ROLES,
	type DataRole,
	MEASURE_KINDS,
	type MeasureKind,
	PROVENANCES,
	type Provenance,
	SETTLEMENT_STATES,
	type SettlementState,
	TOKEN_LAYERS,
	type TokenLayer,
} from "./enums";
export {
	type LegendEntry,
	type LensSpec,
	LensSpecViolation,
	type StyleRule,
	validateLensSpec,
} from "./lens";
export {
	buildCacheKey,
	type CacheKeyInput,
	type CoverageInfo,
	type GraphEdgeV1,
	type GraphNodeV1,
	type GraphPayloadV1,
	isCdnCacheable,
	PAYLOAD_VERSION,
	type PositionMap,
	TIERS,
	type Tier,
} from "./payload";
export {
	AUDIENCES,
	type Audience,
	type EdgeId,
	type GraphRef,
	GraphRefViolation,
	isGraphRef,
	makeCodeRef,
	makeCommunityRef,
	makeCorridorRef,
	makeEdgeId,
	makeRef,
	NODE_KINDS,
	type NodeKind,
	parseRef,
	type RefAlias,
} from "./refs";

export {
	getLensSpec,
	isKnownLensId,
	KNOWN_LENS_IDS,
	LENS_REGISTRY,
	LENS_REGISTRY_VERSION,
} from "./registry";

export {
	type BuildPayloadInput,
	buildPayload,
	SerializerViolation,
} from "./serializer";
