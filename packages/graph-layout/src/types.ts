/**
 * Shared graph-data schema — a generic in-memory graph shape.
 *
 * A `SubstrateData` is just nodes + edges + meta. Node and edge kinds below
 * are the reference vocabulary this library ships (a finance/knowledge graph);
 * callers modelling another domain can supply their own kind strings — the
 * layout and lens helpers only rely on `id`, `kind`, and endpoint references.
 */

// ============================================================================
// Node kinds
// ============================================================================

/**
 * The reference set of node kinds. These are the categories the bundled
 * layout/slice helpers were tuned against; extend or replace them for your
 * own domain.
 */
export type SubstrateNodeKind =
	| "Concept" // a claim or vocabulary term
	| "Citation" // backing reference (paper / industry source)
	| "Currency" // ISO 4217 currency (USD, EUR, JPY, ...)
	| "Country" // sovereign anchor
	| "CBDCProject" // state-level digital currency
	| "FinancialInstitution" // supranational bodies + dealers
	| "FiboClass" // financial-ontology class
	| "Member" // anonymized member (attributes only, no identifying data)
	| "RWAToken" // real-world-asset token
	| "RWAAsset" // real-world-asset underlying
	| "Indicator" // economic indicator
	| "Partner" // partner / counterparty
	| "Asset" // crypto / stablecoin / commodity (non-fiat)
	| "Token" // issued token
	| "Star" // anonymized catalog star (identity layer; no identifying data)
	| "Constellation" // catalog constellation (star-membership hub)
	| "Circle"; // network circle hub

export interface SubstrateNode {
	id: string;
	kind: SubstrateNodeKind;
	label: string;
	/**
	 * Kind-specific properties (e.g. a magnitude on a Member, an ISO code on a
	 * Currency, a year on a Citation). Property-only — never identifying data.
	 */
	props?: Record<string, string | number | boolean | null>;
}

// ============================================================================
// Edge kinds
// ============================================================================

export type SubstrateEdgeKind =
	| "GROUNDS" // claim → citation
	| "DEFINES" // canonical → defined parts
	| "BELONGS_TO" // node → cluster / parent
	| "IN_COUNTRY" // institution → country
	| "USES_CURRENCY" // entity → currency
	| "FOR_CURRENCY" // observation → currency
	| "IN_CLASS" // entity → ontology class
	| "IN_CIRCLE" // member → circle
	| "VARIANT_OF" // variant relationship
	| "SUPERSEDES" // newer claim replaces older
	| "EVOLVED_FROM" // newer derived from older
	| "CONTRADICTS" // two claims explicitly oppose
	| "HAS_PARALLEL" // cross-domain parallel
	| "DERIVED_FROM" // derivation provenance
	| "ISSUED_BY" // currency / asset → issuer
	| "ON_PLATFORM" // token → platform
	| "ON_NETWORK" // token → network
	| "LOCATED_IN" // entity → country
	| "PROVIDES_DATA" // source → observation
	| "ISSUES_CURRENCY" // central bank → currency it issues
	| "TRADES_IN" // institution → currency
	| "HEADQUARTERED_IN" // institution → country
	| "MENTIONS" // concept → structural entity
	| "CROSS_REFERENCES" // concept ↔ concept
	| "MEMBER_OF" // institution → institution (org membership)
	| "PEGS_TO" // stablecoin → currency peg anchor
	| "IN_CONSTELLATION" // star → constellation
	| "CITES_RESEARCH" // concept → research backing
	| "OPERATES_MARKET" // exchange → liquidity pool
	| "HAS_LIVE_RATE"; // currency → asset live-rate bridge

export interface SubstrateEdge {
	id: string;
	source: string;
	target: string;
	kind: SubstrateEdgeKind;
	props?: Record<string, string | number | boolean | null>;
}

// ============================================================================
// Graph slice (data + meta)
// ============================================================================

export interface SubstrateData {
	nodes: SubstrateNode[];
	edges: SubstrateEdge[];
	meta: SubstrateMeta;
}

export interface SubstrateMeta {
	fetchedAt: string; // ISO 8601
	/** Identifier for which slice this is (caller-defined). */
	sliceTag: string;
	counts: Record<string, number>;
	/** Set when a filter actively excluded nodes — informational. */
	redactedCount?: number;
}

// ============================================================================
// Perspective (data lens)
// ============================================================================

/**
 * A named selection over the same data — different subsets/emphasis for
 * different audiences.
 */
export type SubstratePerspective =
	| "public"
	| "researcher"
	| "member-ego"
	| "recipient-class";
