/**
 * Public /graph tier limits — env-driven, shared by API + web.
 *
 * Env knobs (all optional):
 *   PUBLIC_GRAPH_TIER_SIGNAL   — default 500
 *   PUBLIC_GRAPH_TIER_NETWORK  — default 2000
 *   PUBLIC_GRAPH_TIER_DEEP     — default 10000
 *   PUBLIC_GRAPH_FULL_MAX_NODES — anonymous FULL-tier cap (default 10_000 as of
 *     2026-07-07; was 50_000, see below).
 *     The OOM that scarred this (2_000_000) was the :SocialHandle leak — millions of
 *     harvested third-party Bluesky nodes pulled through the driver AND rendered as
 *     individual interactive nodes. The PUBLIC allowlist below now BOUNDS the fetch
 *     to legitimate public reference data (currencies, CBDCs, FIBO, Concepts, …), so
 *     FULL fetches min(cap, real public count) — NOT "everything in Neo4j".
 *     2026-07-07 (graph-estate verdict, tm #751): anonymous default lowered
 *     50_000 → 10_000 (the DEEP working set). Live-measured, anon FULL at 50k
 *     was an outage tier, not a UX tier: ~679KB gz payload, ~7.5s fetch,
 *     ~683MB browser heap, and a client force layout that renders a moiré
 *     hairball at fit-zoom. Neo4j Bloom caps at 10k for the same reason. The
 *     UNGATED path past 10k is server-side Louvain LOD (community super-nodes
 *     that expand on click — taskmaster #580); do NOT raise this knob as a
 *     substitute, and do NOT restore 2_000_000.
 *   PUBLIC_GRAPH_AUTH_MAX_NODES — authenticated FULL-tier cap (default 50_000; was
 *     5_000, which made FULL load fewer nodes than DEEP for logged-in members).
 */

export type PublicGraphTier =
	| "overview"
	| "signal"
	| "network"
	| "deep"
	| "full";

/** Labels never returned to anonymous viewers (PII / custody). */
export const PUBLIC_GRAPH_SENSITIVE_LABELS = [
	"Member",
	"Persona",
	"Wallet",
	"InternalAdmin",
] as const;

export type PublicGraphSensitiveLabel =
	(typeof PUBLIC_GRAPH_SENSITIVE_LABELS)[number];

/**
 * Allowlist — the ONLY node labels returned to anonymous (logged-out) viewers.
 * Safe-by-default: a newly-added or harvested label (e.g. SocialHandle, Voucher,
 * Membership, Investment) does NOT reach the public graph unless explicitly
 * added here. This replaces the prior label DENYLIST, which leaked ~1.8M
 * harvested third-party Bluesky :SocialHandle nodes + member-financial nodes to
 * anonymous viewers (denylist is unsafe-by-default: anything not named leaks).
 * Contents: public monetary/financial reference data, the FIBO/canon ontology,
 * public market observations, and public network identity (star names only —
 * never Member/Persona/Wallet/DID per pii-rules).
 */
export const PUBLIC_GRAPH_PUBLIC_LABELS = [
	// Monetary & financial reference data (public knowledge)
	"Currency",
	"Stablecoin",
	"Cryptocurrency",
	"CBDCProject",
	"CBDCProgram",
	"Country",
	"FinancialInstitution",
	"RegulatoryBody",
	"FXVenue",
	"PaymentSystem",
	"SanctionedEntity",
	"SanctionsList",
	"PriceSource",
	// Ontology / canon (public knowledge graph)
	"FIBO",
	"FiboClass",
	"Concept",
	// Public market data + public network identity (star names, not Member/DID)
	"Observation",
	"Star",
	// EXCLUDED deliberately (do NOT re-add without a prod label audit):
	//  · RWA* (RWANetwork/RWAIssuer/RWAToken/RWAAsset/RWAPlatform/…) — the frozen,
	//    deprecated rwa.xyz EXTERNAL reference subgraph, archived :RwaXyzArchive by
	//    migration 548 (2026-06-07), stale since 2026-02, being removed by the #44
	//    de-RWA rename. Not fxyz's own data.
	//  · Asset / LegalEntity — ambiguous (may carry member-portfolio / internal
	//    entity nodes); add only after confirming they are public-safe on prod.
	//  · SocialHandle — 2.98M harvested third-party Bluesky nodes (mig 308), a
	//    disconnected island; never public.
] as const;

export type PublicGraphPublicLabel =
	(typeof PUBLIC_GRAPH_PUBLIC_LABELS)[number];

function parseEnvInt(name: string, fallback: number): number {
	if (typeof process === "undefined") return fallback;
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPublicGraphFullMaxNodes(isAnonymous: boolean): number {
	return isAnonymous
		? parseEnvInt("PUBLIC_GRAPH_FULL_MAX_NODES", 10_000)
		: parseEnvInt("PUBLIC_GRAPH_AUTH_MAX_NODES", 50_000);
}

/** Resolve GraphQL `limit` (0 = full slice) to a server-side node cap. */
export function resolvePublicGraphLimit(
	limit: number | undefined,
	isAnonymous: boolean,
): number {
	if (limit === 0) {
		return getPublicGraphFullMaxNodes(isAnonymous);
	}
	const cap = getPublicGraphFullMaxNodes(isAnonymous);
	return Math.min(Math.max(limit ?? getPublicGraphTierLimit("signal"), 1), cap);
}

export function getPublicGraphTierLimit(tier: PublicGraphTier): number {
	switch (tier) {
		case "overview":
			// The community LOD tier is not row-capped — it swaps to the
			// communityGraph super-node source (≈135 summary objects), which ignores
			// this limit. Returns 0 (the "full slice" sentinel) for a stable value.
			return 0;
		case "signal":
			return parseEnvInt("PUBLIC_GRAPH_TIER_SIGNAL", 500);
		case "network":
			return parseEnvInt("PUBLIC_GRAPH_TIER_NETWORK", 2_000);
		case "deep":
			return parseEnvInt("PUBLIC_GRAPH_TIER_DEEP", 10_000);
		case "full":
			return 0;
	}
}

export function formatGraphLimitCompact(limit: number): string {
	if (limit >= 1_000_000) {
		const m = limit / 1_000_000;
		return m >= 10
			? `${Math.round(m)}M`
			: `${m.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (limit >= 1_000) {
		const k = limit / 1_000;
		return k >= 10
			? `${Math.round(k)}K`
			: `${k.toFixed(1).replace(/\.0$/, "")}K`;
	}
	return String(limit);
}

/** Cypher fragment: exclude PII-sensitive labels from anonymous public graph. */
export const PUBLIC_GRAPH_SENSITIVE_WHERE = PUBLIC_GRAPH_SENSITIVE_LABELS.map(
	(label) => `NOT n:${label}`,
).join("\n  AND ");

export const PUBLIC_NON_SENSITIVE_COUNT_CYPHER = `
	MATCH (n)
	WHERE ${PUBLIC_GRAPH_SENSITIVE_WHERE}
	RETURN count(n) AS eligibleCount
`;

/**
 * Canonical id-prefix denylist for public :Concept exposure — the internal
 * scratch / governance-meta prefixes that must never reach a public surface.
 */
export const PUBLIC_CONCEPT_ID_DENYLIST_PREFIXES = [
	"C-ERA-",
	"VR-ERA-",
	"LE-ERA-",
	"PF-",
	"NB-",
	"RN-",
	"RD-",
	"claim-",
	"canon-",
	"synthesis-",
	"rule-",
	"proposal-",
] as const;

/**
 * The canonical "is this :Concept public?" Cypher predicate.
 *
 * Reused by any public graph resolver so different callers cannot drift on
 * what counts as a public Concept. Without this gate an anonymous graph
 * endpoint can leak ALL :Concept.claimText — internal-scratch imports,
 * governance meta, unreviewed notes — to logged-out viewers.
 *
 * Returns a Cypher boolean predicate for the given node variable (e.g. "n").
 * `varName` is always a code-literal identifier (never user input) — no injection.
 *
 * TODO: any downstream substrate fetcher should import this predicate
 * rather than reimplementing its own copy, to avoid future drift.
 */
export function publicConceptCypherWhere(varName: string): string {
	const prefixDenylist = PUBLIC_CONCEPT_ID_DENYLIST_PREFIXES.map(
		(p) => `NOT ${varName}.id STARTS WITH '${p}'`,
	).join("\n\t\tAND ");
	return [
		`${varName}.canonStatus = 'active'`,
		`${varName}.redactionFlag IS NULL`,
		`(${varName}.sensitivityTier IS NULL OR ${varName}.sensitivityTier = 'public')`,
		`${varName}.canonScope IN ['core', 'general']`,
		prefixDenylist,
		`NOT ${varName}.id =~ '^C-[0-9]+$'`,
		`NOT ${varName}.id IN ['al-ahad', 'bayt-al-hikmah']`,
	].join("\n\t\tAND ");
}
