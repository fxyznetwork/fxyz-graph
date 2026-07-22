/**
 * Versioned tier payloads + id-keyed positions.
 */

import type {
	DataRole,
	MeasureKind,
	NodeStatus,
	Provenance,
	SettlementState,
	TokenLayer,
} from "./enums";
import type { Audience, EdgeId, GraphRef, NodeKind } from "./refs";

/** Render tiers — GraphPane presets map 1:1, each with its own budget. */
export const TIERS = [
	"peek",
	"chip",
	"tile",
	"drawer",
	"panel",
	"workbench",
	"atlas",
] as const;
export type Tier = (typeof TIERS)[number];

export interface GraphNodeV1 {
	id: GraphRef;
	kind: NodeKind;
	/** Display text. Scrubbed by the serializer — never an identifier/email/name. */
	label: string;
	/**
	 * Whether `label` is a real name or a synthesized fallback (e.g. a
	 * "<dominantLabel> cluster"). Budgeted label selection ranks named ahead of
	 * generic — absent means named.
	 */
	labelQuality?: "named" | "generic";
	/** Binds to the role-based accent scheme. */
	roles?: DataRole[];
	/**
	 * Quantitative fields, keyed by CLOSED MeasureKind. Value null =
	 * unmeasured — null, never zero.
	 */
	measures?: Partial<Record<MeasureKind, number | null>>;
	/** Community assignment (dataVersion travels on the community ref). */
	community?: string;
	tokenLayer?: TokenLayer;
	/** Server-precomputed position — id-keyed, never index-keyed. */
	x?: number;
	y?: number;
	provenance: Provenance;
	editorial?: { status: NodeStatus; sourceId?: string };
}

export interface GraphEdgeV1 {
	id: EdgeId;
	source: GraphRef;
	target: GraphRef;
	type: string;
	weight?: number;
	/** null when unmeasured — never coerced to zero. */
	capacity?: number | null;
	settlementState?: SettlementState;
	provenance: Provenance;
}

/** THE position store: selection and layout key the same way. */
export type PositionMap = Record<GraphRef, { x: number; y: number }>;

/**
 * Orientation framing is audience-gated: member/operator payloads carry totals
 * ("you are seeing X of Y"); public payloads carry the framing label only — no
 * counts in public copy.
 */
export interface CoverageInfo {
	framing: "curated" | "community" | "sampled" | "full";
	totals?: { nodes: number; edges: number };
}

export interface GraphPayloadV1 {
	version: 1;
	audience: Audience;
	tier: Tier;
	nodes: GraphNodeV1[];
	edges: GraphEdgeV1[];
	/**
	 * Legacy id dual-emit for legacy consumers ONLY — additive, never an
	 * in-place id-semantics change. Dropped at payload v2. Never present on
	 * public payloads.
	 */
	legacyIdMap?: Record<GraphRef, string>;
	coverage: CoverageInfo;
	sampled: boolean;
	positionsIncluded: boolean;
	/**
	 * Derived from lens + scope + tier + dataVersion + audience + aclVersion.
	 * Only audience:'public' payloads are CDN-cacheable; member/operator are
	 * no-store, always.
	 */
	cacheKey: string;
}

export interface CacheKeyInput {
	lens: string;
	scope: string;
	tier: Tier;
	dataVersion: string;
	audience: Audience;
	aclVersion: string;
}

export const PAYLOAD_VERSION = 1 as const;

export function buildCacheKey(input: CacheKeyInput): string {
	const parts = [
		`v${PAYLOAD_VERSION}`,
		input.audience,
		input.lens,
		input.scope,
		input.tier,
		input.dataVersion,
		input.aclVersion,
	];
	return parts.join("|");
}

/** Only public payloads may ride the CDN. */
export function isCdnCacheable(
	payload: Pick<GraphPayloadV1, "audience">,
): boolean {
	return payload.audience === "public";
}
