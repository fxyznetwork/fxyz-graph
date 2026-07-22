/**
 * Lens registry v1.
 *
 * The catalog of lenses that exist as real surfaces. An entry here is a lens a
 * member can stand on; a lens enters this catalog when its surface ships, not
 * before.
 *
 * The registry is the shared vocabulary for lens IDs: saved views validate
 * their `lens` field against it, the graph surface seeds from it, and the
 * engine lens runtime (incremental styling deltas) consumes the styleRules.
 * Style rules recorded here are the definitional minimum for each lens.
 */

import type { LensSpec } from "./lens";
import { validateLensSpec } from "./lens";
import { NODE_KINDS, type NodeKind } from "./refs";

/** Bump on breaking registry-shape changes (contract-version event). */
export const LENS_REGISTRY_VERSION = 1;

/**
 * Label budgets by level-of-detail depth: 80/120/200 — never more than the
 * overlay can hold at 60fps.
 */
const LABEL_BUDGETS = { far: 80, mid: 120, near: 200 } as const;

/**
 * Node kinds safe for member-audience, workbench-tier lenses. `member`
 * (internal person identity) and `code` (its own surface) stay out.
 */
const WORKBENCH_KINDS: NodeKind[] = NODE_KINDS.filter(
	(kind) => kind !== "member" && kind !== "code",
);

const ENTRIES: LensSpec[] = [
	{
		// Default — the unstyled workbench-tier view.
		id: "raw",
		title: "Raw",
		audience: "member",
		seed: { kind: "scope", scope: "network" },
		nodeKinds: WORKBENCH_KINDS,
		relTypes: [], // workbench shows all served relationship types; no lens filter
		// Degree → size (area-true, 6..48): a large point cloud with uniform
		// discs has no visual hierarchy — hubs must read as hubs.
		styleRules: [{ source: "degree", channel: "size" }],
		legend: [{ encoding: "size", label: "Size = connections" }],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		// Louvain communities coloring.
		id: "communities",
		title: "Communities",
		audience: "member",
		seed: { kind: "scope", scope: "network" },
		nodeKinds: WORKBENCH_KINDS,
		relTypes: [],
		// Categorical community coloring: each node's version-qualified community
		// ref maps deterministically to a palette hue (engine applyStyleRules
		// `community` source). The topology-role rule stays as the no-community
		// DEFAULT — nodes the community assignment doesn't cover keep the lens's
		// topology accent rather than going bare.
		styleRules: [
			{ source: "prop:louvainCommunity", channel: "color", role: "topology" },
			{ source: "community", channel: "color" },
		],
		legend: [{ encoding: "community", label: "Color = community" }],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		// Degree-coreness emphasis.
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
	// The FX lens family — each id is one algorithm source for the FX scope's
	// member-audience, workbench-tier lenses. Degree drives area-true size
	// through the one style pipeline.
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
		// Public network overview — a precomputed community-summary tier of
		// positioned super-nodes, never the raw graph.
		id: "public-overview",
		title: "Network overview",
		audience: "public",
		seed: { kind: "scope", scope: "overview" },
		nodeKinds: ["community"],
		relTypes: ["GRAPH_COMMUNITY_LINK"],
		// Community size rides measures.count (contract nodes carry no props
		// bag, so a `prop:` source can never resolve against GraphNodeV1).
		// Color binds each community's own data role (from its dominant label)
		// to the role-based accents — role, never route.
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
		// budget, not the highest-degree ones.
		labelRankMeasure: "count",
		tier: "panel",
	},
	{
		// The FIBO financial ontology as a first-class scope for member-audience,
		// workbench-tier lenses. Financial-ontology classes as nodes, SUBCLASS_OF
		// as edges. Served through the shared buildPayload path. Role-coloured
		// (every class is financial-ontology → money) + degree-sized, exactly the
		// market map's visual grammar.
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
		// The organisation's governance structure as a first-class scope for
		// member-audience, workbench-tier lenses, the fibo scope's twin. Circles +
		// roles + the domains they own or are accountable for: circles/roles/domains
		// as nodes, PARENT_OF + HAS_ROLE + OWNS_DOMAIN + ACCOUNTABLE_FOR as edges.
		// Aggregate distinct member/filler counts as the count measure — counts
		// only, never identities; domains carry no such aggregate and stay
		// count:null, never invented. Served through the shared buildPayload path.
		// Governance-role coloured + degree-sized, mirroring the fibo lens's
		// grammar.
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
		// A single node's lineage as a seeded scope: the seed node at the origin,
		// lineage relationship types as edges, degree driving size. A seeded lens —
		// the actual seed is supplied per request (a ref seed cannot bake in a
		// dynamic id, so it is declared here as a scope seed). Lineage maps to the
		// topology role, degree-sized.
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
			{ encoding: "role", role: "topology", label: "Lineage" },
		],
		labelBudget: LABEL_BUDGETS.near,
		tier: "workbench",
	},
	{
		// Public market map: currency/market structure coloured by DATA ROLE,
		// never route — each node binds its own role (currencies → money) to the
		// role-based accents, degree drives area-true size. Public audience, so
		// the operator-only member kind is out.
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
		// Public entity ego: the entity-detail panel lens — one seed
		// (cbdc/token/fibo/partner ref) plus its typed, allowlisted neighborhood
		// as a radial tree. Small graphs by design → near label budget (label
		// everything). Token seeds may be fxyz's own tokens, so ALL four layers
		// are declared — displayed side by side, never converted.
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
		allowedTokenLayers: ["position", "settlement", "work", "knowledge"],
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
