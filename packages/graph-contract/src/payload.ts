/**
 * Versioned tier payloads (engine law 15) + id-keyed positions (law 13).
 */

import type {
	CanonStatus,
	DataRole,
	MeasureKind,
	Provenance,
	SettlementState,
	TokenLayer,
} from "./enums";
import type { Audience, EdgeId, GraphRef, NodeKind } from "./refs";

/** Render tiers — GraphPane presets map 1:1 (DESIGN-V2 §4 budget table). */
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
	/** Display text. PII-scrubbed by the serializer — never a DID/email/name. */
	label: string;
	/**
	 * Whether `label` is a real name or a synthesized fallback (e.g. the
	 * precompute's "<dominantLabel> cluster"). Budgeted label selection ranks
	 * named ahead of generic (#1071) — absent means named.
	 */
	labelQuality?: "named" | "generic";
	/** Binds to the locked --fx-role-* accents via visual-grammar. */
	roles?: DataRole[];
	/**
	 * Quantitative fields, keyed by CLOSED MeasureKind (law 17). Value null =
	 * unmeasured — null, never zero (money-map law 2).
	 */
	measures?: Partial<Record<MeasureKind, number | null>>;
	/** Community assignment (dataVersion travels on the community ref). */
	community?: string;
	tokenLayer?: TokenLayer;
	/** Server-precomputed position — id-keyed, never index-keyed (law 13). */
	x?: number;
	y?: number;
	provenance: Provenance;
	canon?: { conceptId: string; status: CanonStatus };
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
 * Orientation framing is audience-gated (codex finding 13): member/operator
 * payloads carry totals ("you are seeing X of Y"); public payloads carry the
 * framing label only — no counts in public copy.
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
	 * elementId dual-emit for legacy consumers ONLY — additive migration,
	 * never an in-place id-semantics change. Dropped at payload v2. Never
	 * present on public payloads.
	 */
	legacyIdMap?: Record<GraphRef, string>;
	coverage: CoverageInfo;
	sampled: boolean;
	positionsIncluded: boolean;
	/**
	 * lens + scope + tier + dataVersion + audience + aclVersion +
	 * projectionVersion (codex finding 6). Only audience:'public' payloads are
	 * CDN-cacheable; member/operator are no-store, always.
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

/** Only public payloads may ride the CDN (codex finding 6). */
export function isCdnCacheable(
	payload: Pick<GraphPayloadV1, "audience">,
): boolean {
	return payload.audience === "public";
}
