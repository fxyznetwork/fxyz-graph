/**
 * Lens registry v1 (DESIGN-V2 §5/§6 — the V2-P1 "LensSpec registry v1" item).
 *
 * The CATALOG of lenses that exist as real surfaces today — real-or-remove:
 * an entry here means a member can stand on that lens right now. Speculative
 * lenses (money-map family, org lens, code lens) enter when their surface
 * ships (P2/P3), not before.
 *
 * The registry is the shared vocabulary for lens IDs: saved views validate
 * their `lens` field against it, /graph seeds from it, and the P2 engine
 * lens runtime (incremental styling deltas) will consume the styleRules.
 * Style rules recorded here are the definitional minimum for each lens —
 * the P2 runtime is the enforcement point, and deepening them is P2 work.
 */

import type { LensSpec } from "./lens";
import { validateLensSpec } from "./lens";
import { NODE_KINDS, type NodeKind } from "./refs";

/** Bump on breaking registry-shape changes (contract-version event). */
export const LENS_REGISTRY_VERSION = 1;

/**
 * Label budgets are LAW (engine law 6, fair-run measured): 80/120/200 by
 * LOD depth — never more than the overlay can hold at 60fps.
 */
const LABEL_BUDGETS = { far: 80, mid: 120, near: 200 } as const;

/**
 * The member workbench renders every member-safe kind. `member:` (operator
 * DID identity) and `code:` (graphify lens family, own surface) stay out.
 */
const WORKBENCH_KINDS: NodeKind[] = NODE_KINDS.filter(
	(kind) => kind !== "member" && kind !== "code",
);

const ENTRIES: LensSpec[] = [
	{
		// /graph default — the unstyled member workbench view.
		id: "raw",
		title: "Raw",
		audience: "member",
		seed: { kind: "scope", scope: "network" },
		nodeKinds: WORKBENCH_KINDS,
		relTypes: [], // workbench shows all served rel-types; no lens filter
		// Degree → size (area-true, 6..48): a 10k point cloud with uniform
		// discs has no visual hierarchy — hubs must read as hubs (#1095).
		styleRules: [{ source: "degree", channel: "size" }],
		legend: [{ encoding: "size", label: "Size = connections" }],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		// /graph?lens=communities — Louvain communities coloring (#580 tier).
		id: "communities",
		title: "Communities",
		audience: "member",
		seed: { kind: "scope", scope: "network" },
		nodeKinds: WORKBENCH_KINDS,
		relTypes: [],
		// Categorical community coloring (#1082): each node's version-qualified
		// community ref maps deterministically to a palette hue (engine
		// applyStyleRules `community` source). The topology-role rule stays as the
		// no-community DEFAULT — nodes the community assignment doesn't cover keep
		// the lens's topology accent rather than going bare.
		styleRules: [
			{ source: "prop:louvainCommunity", channel: "color", role: "topology" },
			{ source: "community", channel: "color" },
		],
		legend: [{ encoding: "community", label: "Color = community" }],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		// /graph?lens=core-periphery — degree-coreness emphasis.
		id: "core-periphery",
		title: "Core / periphery",
		audience: "member",
		seed: { kind: "scope", scope: "network" },
		nodeKinds: WORKBENCH_KINDS,
		relTypes: [],
		styleRules: [{ source: "degree", channel: "brightness" }],
		legend: [
			{ encoding: "brightness", label: "Bright = core, dim = periphery" },
		],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	// The FX lens family (/graph?view=fx — folded onto GraphPane, tm #971).
	// Enter WITH their surface (real-or-remove): each id is one algorithm
	// source of the member FX workbench. Degree drives area-true size (the
	// old hand-rolled 14+deg·2.2 sizing, now through the one style pipeline).
	{
		id: "fx-correlation",
		title: "FX correlation",
		audience: "member",
		seed: { kind: "scope", scope: "fx" },
		nodeKinds: ["currency"],
		relTypes: ["CORRELATED"],
		styleRules: [{ source: "degree", channel: "size" }],
		legend: [{ encoding: "size", label: "Size = connections" }],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		id: "fx-mst",
		title: "FX minimum spanning tree",
		audience: "member",
		seed: { kind: "scope", scope: "fx" },
		nodeKinds: ["currency"],
		relTypes: ["MST_LINK"],
		styleRules: [{ source: "degree", channel: "size" }],
		legend: [{ encoding: "size", label: "Size = connections" }],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		id: "fx-pmfg",
		title: "FX planar filtered graph",
		audience: "member",
		seed: { kind: "scope", scope: "fx" },
		nodeKinds: ["currency"],
		relTypes: ["PMFG_LINK"],
		styleRules: [{ source: "degree", channel: "size" }],
		legend: [{ encoding: "size", label: "Size = connections" }],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		id: "fx-arbitrage",
		title: "Arbitrage cycles",
		audience: "member",
		seed: { kind: "scope", scope: "fx" },
		nodeKinds: ["currency"],
		relTypes: ["ARB_HOP"],
		styleRules: [{ source: "degree", channel: "size" }],
		legend: [{ encoding: "size", label: "Size = connections" }],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		id: "fx-route",
		title: "Optimal route",
		audience: "member",
		seed: { kind: "scope", scope: "fx" },
		nodeKinds: ["currency"],
		relTypes: ["ROUTE_HOP"],
		styleRules: [{ source: "degree", channel: "size" }],
		legend: [{ encoding: "size", label: "Size = connections" }],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		// Public /graph Overview — the precomputed :GraphCommunity summary tier
		// (134 positioned super-nodes), never the raw graph.
		id: "public-overview",
		title: "Network overview",
		audience: "public",
		seed: { kind: "scope", scope: "overview" },
		nodeKinds: ["community"],
		relTypes: ["GRAPH_COMMUNITY_LINK"],
		// Community size rides measures.count (contract nodes carry no props
		// bag — a `prop:` source can never resolve against GraphNodeV1; fixed
		// when the P2 overview route landed). Color binds each community's
		// own data role (dominantLabel → DataRole, mapped by the overview
		// route) to the locked --fx-role-* accents — role, never route.
		styleRules: [
			{ source: "count", channel: "size" },
			{ source: "prop:roles", channel: "color" },
		],
		legend: [
			{ encoding: "size", label: "Size = entities inside" },
			{ encoding: "role", role: "money", label: "Money" },
			{ encoding: "role", role: "flow", label: "Flow" },
			{ encoding: "role", role: "governance", label: "Governance" },
			{ encoding: "role", role: "topology", label: "Topology" },
			{ encoding: "role", role: "compliance", label: "Compliance" },
		],
		labelBudget: LABEL_BUDGETS.far,
		// Label salience rides count too: the biggest communities get the
		// budget, not the highest-degree ones (degree ranking surfaced
		// "… cluster" fallbacks over exemplar-named majors).
		labelRankMeasure: "count",
		tier: "panel",
	},
	{
		// /graph?scope=fibo — the FIBO financial ontology as a first-class scope
		// on the member workbench (tm #1103, founder mandate "FIBO is the main").
		// :FiboClass hierarchy: classes as nodes, SUBCLASS_OF as edges. Member
		// lens (raw/communities kin), workbench tier — served through the same
		// buildPayload choke point (/api/graph/fibo). Role-coloured (every class
		// is financial-ontology → money) + degree-sized, exactly the market map's
		// visual grammar. Real-or-remove: enters WITH its /api/graph/fibo surface.
		id: "fibo",
		title: "FIBO ontology",
		audience: "member",
		seed: { kind: "scope", scope: "fibo" },
		nodeKinds: ["fibo"],
		relTypes: ["SUBCLASS_OF"],
		styleRules: [
			{ source: "prop:roles", channel: "color" },
			{ source: "degree", channel: "size" },
		],
		legend: [
			{ encoding: "size", label: "Size = connections" },
			{ encoding: "role", role: "money", label: "Financial ontology" },
		],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		// /graph?scope=org — the org's Holacracy governance structure as a
		// first-class scope on the member workbench (graph-refoundation
		// programme, "one graph, many lenses"), the fibo scope's twin. The
		// :Circle hierarchy + :HolacracyRole nodes + the :Domain objects they
		// own/are accountable for (mig 123/124, tm #1105): circles/roles/domains
		// as nodes, PARENT_OF + HAS_ROLE + OWNS_DOMAIN + ACCOUNTABLE_FOR as edges,
		// aggregate distinct member/filler counts as the count measure (PII LAW:
		// counts only, never identities — domains carry no such aggregate and
		// stay count:null, never invented). Member
		// lens, workbench tier — served through the same buildPayload choke point
		// (/api/graph/org, member/no-store posture: governance instances are
		// member-gated across the estate). Governance-role coloured (every node
		// is the org's governance structure → governance) + degree-sized,
		// mirroring the fibo lens's grammar. Real-or-remove: enters WITH its
		// /api/graph/org surface.
		id: "org",
		title: "Org structure",
		audience: "member",
		seed: { kind: "scope", scope: "org" },
		nodeKinds: ["circle", "role", "domain"],
		relTypes: ["PARENT_OF", "HAS_ROLE", "OWNS_DOMAIN", "ACCOUNTABLE_FOR"],
		styleRules: [
			{ source: "prop:roles", channel: "color" },
			{ source: "degree", channel: "size" },
		],
		legend: [
			{ encoding: "size", label: "Size = connections" },
			{ encoding: "role", role: "governance", label: "Governance structure" },
		],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		// /knowledge concept detail — a single :Concept's canon lineage as a
		// seeded scope on the member workbench (graph-refoundation programme, "one
		// graph, many lenses"), the fibo/org scopes' canon twin. Concepts as
		// nodes, the lineage rel-type SUPERSET (both writer spellings deliberately
		// — the live graph mixes vocabularies) as edges, degree drives size, the
		// seed at the origin. A SEEDED/route-ish lens: the actual seed is the
		// per-request conceptId, declared here as a scope seed exactly like the
		// fx-route family (a ref seed cannot bake in a dynamic conceptId). Member
		// lens (canon lineage surfaces retired/contested predecessors — member-
		// surface data), workbench tier — served through the same buildPayload
		// choke point (/api/graph/provenance, member/no-store posture).
		// Governance-adjacent knowledge → topology role (roleForLabel), degree-
		// sized, mirroring the fibo/org grammar. Real-or-remove: enters WITH its
		// /api/graph/provenance surface + the /knowledge Lineage panel.
		id: "provenance",
		title: "Provenance",
		audience: "member",
		seed: { kind: "scope", scope: "provenance" },
		nodeKinds: ["concept"],
		relTypes: [
			"SUPERSEDES",
			"SUPERSEDED_BY",
			"SUCCEEDED_BY",
			"MERGES_FROM",
			"DEDUPS_TO",
			"PROMOTED_FROM",
			"PROMOTED_FROM_ARCHIVE",
			"DERIVED_FROM",
		],
		styleRules: [
			{ source: "prop:roles", channel: "color" },
			{ source: "degree", channel: "size" },
		],
		legend: [
			{ encoding: "size", label: "Size = connections" },
			{ encoding: "role", role: "topology", label: "Canon lineage" },
		],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		// Public market map (V2-P3 money-map face): currency/market structure
		// coloured by DATA ROLE, never route — each node binds its own role
		// (currencies → money) to the locked --fx-role-* accents, degree drives
		// area-true size. Public audience, so the operator-only member kind is
		// out (real-or-remove; the money-map heroes deepen this in P3).
		id: "market",
		title: "Market map",
		audience: "public",
		seed: { kind: "scope", scope: "market" },
		nodeKinds: ["currency", "corridor", "indicator", "asset"],
		relTypes: ["CORRELATED", "QUOTES", "ROUTE_HOP"],
		styleRules: [
			{ source: "prop:roles", channel: "color" },
			{ source: "degree", channel: "size" },
		],
		legend: [
			{ encoding: "size", label: "Size = connections" },
			{ encoding: "role", role: "money", label: "Money" },
			{ encoding: "role", role: "flow", label: "Flow" },
		],
		labelBudget: LABEL_BUDGETS.far,
		tier: "panel",
	},
	{
		// Public entity ego (tm #1123): the entity-detail panel lens — one seed
		// (cbdc/token/fibo/partner ref) plus its typed, allowlisted neighborhood
		// as a radial tree. Small graphs by design → near label budget (label
		// everything). Token seeds may be fxyz's own tokens, so ALL four layers
		// are declared — display side by side, never converted (token-layer
		// distinction).
		id: "ego",
		title: "Connections",
		audience: "public",
		seed: { kind: "scope", scope: "ego" },
		nodeKinds: [
			"cbdc",
			"country",
			"token",
			"currency",
			"institution",
			"fibo",
			"partner",
			"corridor",
		],
		relTypes: [
			"IN_COUNTRY",
			"PEGS_TO",
			"QUOTED_IN",
			"USES_CURRENCY",
			"ISSUES_CURRENCY",
			"SUBCLASS_OF",
			"subClassOf",
			"VIA_PARTNER",
		],
		styleRules: [
			{ source: "prop:roles", channel: "color" },
			{ source: "degree", channel: "size" },
		],
		legend: [
			{ encoding: "size", label: "Size = connections" },
			{ encoding: "role", role: "money", label: "Money" },
			{ encoding: "role", role: "flow", label: "Flow" },
		],
		labelBudget: LABEL_BUDGETS.near,
		tier: "panel",
		allowedTokenLayers: ["fxyz-position", "florin-settlement", "joule", "how"],
	},
];

/** id → spec. Every entry is validated at module init (fail-loud). */
export const LENS_REGISTRY: ReadonlyMap<string, LensSpec> = new Map(
	ENTRIES.map((spec) => [spec.id, Object.freeze(validateLensSpec(spec))]),
);

export const KNOWN_LENS_IDS: readonly string[] = ENTRIES.map((s) => s.id);

export function getLensSpec(id: string): LensSpec | null {
	return LENS_REGISTRY.get(id) ?? null;
}

export function isKnownLensId(id: string): boolean {
	return LENS_REGISTRY.has(id);
}
