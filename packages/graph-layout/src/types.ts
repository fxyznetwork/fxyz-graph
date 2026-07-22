/**
 * Substrate-render — shared type schema.
 *
 * Mirrors the Neo4j prod canon graph property schema (post-migrations 115-121).
 * Authoritative source is the graph; these types are projections used by
 * surfaces (web/app/deck/docs).
 */

// ============================================================================
// Canon properties (mirror Neo4j Concept schema)
// ============================================================================

export type CanonStatus =
	| "active"
	| "lineage"
	| "retired"
	| "superseded"
	| "contested"
	| "awaiting_grounding"
	| "proposal";

export type CanonScope =
	| "core"
	| "vocabulary"
	| "parallel"
	| "anchor"
	| "lineage"
	| "operational"
	| "reference"
	| "general";

export type SourceEra =
	| "lagrange"
	| "interim"
	| "fxyz-early"
	| "fxyz-launch"
	| "untriaged";

// ============================================================================
// Substrate node kinds (subset rendered in public surfaces)
// ============================================================================

/**
 * Node kinds visible in the public substrate render.
 *
 * Excluded from public render: `Star` (cosmic naming, not material), all
 * `Observation` subclasses (massive, not relevant to substrate shape),
 * `Prospect` (private pipeline), `Member` PII fields (only anonymized
 * magnitude + layer assignments surface).
 */
export type SubstrateNodeKind =
	| "Concept" // canonical claim or vocabulary term
	| "Citation" // backing reference (paper / industry source)
	| "Currency" // ISO 4217 currency layer (USD, EUR, JPY, ...)
	| "Country" // sovereign anchor (geo-redaction-filtered)
	| "CBDCProject" // state-level digital currency
	| "FinancialInstitution" // supranational + dealers
	| "FiboClass" // ontology class
	| "Member" // anonymized member (magnitude + layer only)
	// 2026-05-09 hero Option A: surface our own data, drop rwa.xyz scrape.
	// RWAAsset (2888 nodes) is data scraped from rwa.xyz (founder reports
	// the source is dormant + the data is "hallucination") — dropped from
	// the slice via DEFAULTS.maxRwaAssets = 0. The type entry is kept
	// per `.claude/rules/no-revert-no-delete-culture.md` so existing code
	// paths still compile; no new RWAAsset rows reach the renderer.
	| "RWAToken" // real-world-asset token (DROPPED from slice — see RWAAsset note)
	| "RWAAsset" // RWA underlying asset (DROPPED from slice — see note above)
	| "Indicator" // economic indicator
	| "Partner" // existing partner / counterparty (active + potential)
	// 2026-05-09 hero Option A — additions:
	| "Asset" // crypto / stablecoin / commodity (NOT fiat — Currency owns ISO)
	| "Token" // ƒxyz-issued tokens (Florin / Joule / HoW + USDC representative)
	| "Star" // anonymized HIP catalog star (Identity layer; no PII)
	// 2026-06-11 Wave A.1 (docs/audits/2026-06-10-landing-rebuild/
	// slice-isolation-gap.md item 1) — IN_CONSTELLATION was whitelisted but
	// Constellation was never a fetched kind, so all 200 Stars sat isolated.
	// Fetching ≤20 degree-ordered (by star-membership) Constellation nodes
	// connects up to 200 Stars for a handful of added nodes.
	| "Constellation" // IAU constellation (mig 017; star-membership hub)
	// 2026-06-11 Wave A.2 (slice-isolation-gap.md item 2) — Partners attach to
	// the network via (:Partner)-[:IN_CIRCLE]->(:Circle {circleType:'network'})
	// (seed-partners.ts:186/224 — the partners hub is `circle-partners`, a
	// :Circle node, NOT a dedicated :PartnerCircle label). Without the Circle
	// hub fetched, 87/96 Partners sat isolated (only US/TR/MX/BR/SG resolved via
	// the synth jurisdiction bridge). The slice fetches ONLY network-type
	// circles (the partners hub) — holacracy governance circles (anchor /
	// functional / community / seed circleTypes, which carry role/ACL/member
	// org-chart data) are excluded at query time.
	| "Circle"; // network-type circle hub (partners) — PII-safe (name only)

export interface SubstrateNode {
	id: string;
	kind: SubstrateNodeKind;
	label: string;
	canonStatus?: CanonStatus;
	canonScope?: CanonScope;
	sourceEra?: SourceEra;
	/**
	 * Node-kind-specific properties (e.g. magnitude on Member, ISO code on
	 * Currency, year on Citation). Always property-only — no PII.
	 */
	props?: Record<string, string | number | boolean | null>;
}

// ============================================================================
// Substrate edge kinds
// ============================================================================

export type SubstrateEdgeKind =
	| "GROUNDS" // claim → citation
	| "DEFINES" // canonical → defined parts
	| "BELONGS_TO" // node → cluster / parent
	| "IN_COUNTRY" // institution → country
	| "USES_CURRENCY" // entity → currency
	| "FOR_CURRENCY" // observation → currency
	| "IN_CLASS" // entity → fibo class
	| "IN_CIRCLE" // member → circle
	| "VARIANT_OF" // contested / aspectual variant
	| "SUPERSEDES" // newer claim replaces older
	| "EVOLVED_FROM" // newer derived from older
	| "CONTRADICTS" // two claims explicitly oppose
	| "HAS_PARALLEL" // cross-cultural parallel
	| "DERIVED_FROM" // derivation provenance
	| "ISSUED_BY" // currency / asset → issuer
	| "ON_PLATFORM" // RWA token → platform
	| "ON_NETWORK" // RWA token → network
	| "LOCATED_IN" // entity → country
	| "PROVIDES_DATA" // source → observation
	// Migration 139 (2026-05-07) — bridge edges
	| "ISSUES_CURRENCY" // central bank → currency it issues
	| "TRADES_IN" // FI → currency (existing 120 edges, now exposed)
	| "HEADQUARTERED_IN" // FI → country (alternative to LOCATED_IN, future use)
	| "MENTIONS" // canon Concept → structural entity (FI / Country / Currency / CBDCProject)
	| "CROSS_REFERENCES" // research-concept ↔ research-concept (TTA / TE / MRO / NV)
	| "MEMBER_OF" // FI → FI org membership (e.g. central banks ⊂ BIS, commercial ⊂ regional supranational)
	// 2026-06-10 slice-richness wave A (docs/audits/2026-06-10-landing-rebuild/
	// slice.md §3 Option A item 3) — real graph edges that were silently dropped
	// because the whitelist predated them:
	| "PEGS_TO" // Stablecoin → Currency peg anchor (mig 302/542; symbol-bridged to the slice's Asset kind)
	| "IN_CONSTELLATION" // Star → Constellation (mig 017; inert until Constellation nodes join the slice)
	| "CITES_RESEARCH" // Concept → Research backing (migs 245/246/250; inert until Research nodes join the slice)
	| "OPERATES_MARKET" // CryptoExchange → LiquidityPool (mig 535; inert until those kinds join the slice)
	| "HAS_LIVE_RATE"; // Currency → Asset:FiatCurrency live-rate bridge (mig 531; fiat Assets currently excluded from the slice)

export interface SubstrateEdge {
	id: string;
	source: string;
	target: string;
	kind: SubstrateEdgeKind;
	props?: Record<string, string | number | boolean | null>;
}

// ============================================================================
// Substrate slice (data + meta)
// ============================================================================

export interface SubstrateData {
	nodes: SubstrateNode[];
	edges: SubstrateEdge[];
	meta: SubstrateMeta;
}

export interface SubstrateMeta {
	fetchedAt: string; // ISO 8601
	sliceTag: string; // 'public-landing' | 'researcher' | 'member-ego' | 'recipient-class'
	counts: Record<string, number>;
	/** Set when redaction filter actively excluded nodes — informational. */
	redactedCount?: number;
}

// ============================================================================
// Perspective (data lens)
// ============================================================================

/**
 * Lens applied to the substrate. Same data, different selection + emphasis.
 */
export type SubstratePerspective =
	| "public" // anonymized full-prod
	| "researcher" // citations + provenance edges expanded
	| "member-ego" // member's neighborhood
	| "recipient-class"; // recipient-class filter (deck only)
