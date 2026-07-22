/**
 * @fxyz/graph-layout — public API.
 *
 * Layout + data-shaping helpers for a client-supplied graph dataset. The root
 * export is the shared data schema (SubstrateData / SubstrateNode /
 * SubstrateEdge); the runtime helpers live on subpaths:
 *
 *   import { buildLandingSlice } from '@fxyz/graph-layout/landing-substrate';
 */

// Client-side graph lenses (SCOPE × FILTER × LENS, third axis). Pure functions
// over an already-loaded graph — no query, orthogonal to scope.
export {
	COMMUNITY_PALETTE,
	CORE_HEX,
	type CommunityPartitionStats,
	communitiesPartitionStats,
	computeLensColors,
	type GraphLens,
	isTrivialCommunityPartition,
	type LensLink,
	type LensNode,
	type LensTheme,
	LOUVAIN_PRECOMPUTE_COVERAGE_THRESHOLD,
	PERIPHERY_HEX,
} from "./graph-lens";

export {
	formatGraphLimitCompact,
	getPublicGraphFullMaxNodes,
	getPublicGraphTierLimit,
	PUBLIC_CONCEPT_ID_DENYLIST_PREFIXES,
	PUBLIC_GRAPH_PUBLIC_LABELS,
	PUBLIC_GRAPH_SENSITIVE_LABELS,
	PUBLIC_GRAPH_SENSITIVE_WHERE,
	PUBLIC_NON_SENSITIVE_COUNT_CYPHER,
	type PublicGraphPublicLabel,
	type PublicGraphSensitiveLabel,
	type PublicGraphTier,
	publicConceptCypherWhere,
	resolvePublicGraphLimit,
} from "./public-graph-limits";
export type {
	CanonScope,
	CanonStatus,
	SourceEra,
	SubstrateData,
	SubstrateEdge,
	SubstrateEdgeKind,
	SubstrateMeta,
	SubstrateNode,
	SubstrateNodeKind,
	SubstratePerspective,
} from "./types";
