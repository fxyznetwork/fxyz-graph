/**
 * @fxyz/graph-layout — public API.
 *
 * Layout + data-shaping helpers for a caller-supplied graph dataset. The root
 * export is the shared in-memory graph schema (SubstrateData / SubstrateNode /
 * SubstrateEdge — a generic nodes + edges + meta shape) plus a set of pure
 * client-side lenses that recolour an already-loaded graph. The positioned
 * landing-slice builder lives on a subpath:
 *
 *   import { buildLandingSlice } from '@fxyz/graph-layout/landing-substrate';
 */

// Client-side graph lenses (recolour an already-loaded graph). Pure functions
// over the in-context nodes + links — they need no extra data load.
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

// Generic in-memory graph-data schema (nodes + edges + meta).
export type {
	SubstrateData,
	SubstrateEdge,
	SubstrateEdgeKind,
	SubstrateMeta,
	SubstrateNode,
	SubstrateNodeKind,
	SubstratePerspective,
} from "./types";
