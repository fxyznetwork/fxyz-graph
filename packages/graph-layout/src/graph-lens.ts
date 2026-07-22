/**
 * Graph lenses — client-side analytical re-readings of an already-loaded graph.
 *
 * A "lens" is the third axis of the unified graph model (SCOPE × FILTER × LENS):
 * it does not change WHICH data is loaded (that is SCOPE) nor WHICH node types
 * are visible (FILTER) — it changes HOW the loaded nodes are read, by recolouring
 * them according to a structural property computed from the nodes + links that
 * are already in hand. Because every lens computes from the in-context graph, a
 * lens needs no extra query and is orthogonal to scope: the same lens reads a
 * personal ego-graph, the whole network, or a star-centred view identically.
 *
 * Lenses here are colour-only — they emit a `Map<nodeId, hex>` consumed by
 * UnifiedGraph's existing `nodeColorOverrides` prop. (The FX lens — currency
 * correlation / MST / PMFG / arbitrage — is NOT here; it needs price data, so it
 * lives with the lab fold-in, P4.)
 *
 * Algorithms are named + published (operator-hud-grounding.md "(c)"):
 *   - communities: Louvain modularity (Blondel, Guillaume, Lambiotte, Lefebvre,
 *     J. Stat. Mech. 2008) via graphology-communities-louvain.
 *   - core-periphery: k-core decomposition (Seidman, Social Networks 1983),
 *     coreness via the O(m) peeling of Batagelj & Zaversnik (2003).
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";

export type GraphLens = "raw" | "communities" | "core-periphery";

/** Minimal node shape a lens needs — a stable id, plus (optionally) the node's
 *  property record so lenses can prefer server-precomputed structure (e.g.
 *  `properties.louvainCommunity` from the #580 Louvain precompute) over a
 *  client-side recompute. Callers that pass bare `{ id }` nodes keep the full
 *  client-side behaviour. */
export interface LensNode {
	id: string;
	properties?: Record<string, unknown>;
}

/** Minimal link shape a lens needs — endpoints by node id. */
export interface LensLink {
	source: string;
	target: string;
}

export type LensTheme = "light" | "dark";

/**
 * Distinct functional hues for the Louvain communities lens. Functional (a
 * categorical scale), not brand copy — communities have no canon meaning, so
 * the palette only needs to be perceptually separable.
 *
 * This is the SINGLE SOURCE for the community palette: other consumers should
 * import it instead of keeping their own copy, so every surface reads
 * communities in the same colours.
 */
export const COMMUNITY_PALETTE = [
	"#fbbc7a",
	"#e87044",
	"#5c7ad3",
	"#aec2f8",
	"#64be25",
	"#d98cce",
	"#c2a83e",
	"#7a86a8",
] as const;

/** Core hue, theme-aware. Shared with the lab's applyCorePeriphery. */
export const CORE_HEX: Record<LensTheme, string> = {
	dark: "#ad5700",
	light: "#fbbc7a",
};
/** Periphery hue, theme-aware. Shared with the lab's applyCorePeriphery. */
export const PERIPHERY_HEX: Record<LensTheme, string> = {
	dark: "#546cb7",
	light: "#aec2f8",
};

/**
 * Build a simple undirected graphology graph from id-bearing nodes + endpoint
 * links. Defensive against the empty/duplicate ids that canon-promotion
 * artefacts have produced in the wild, and against self-loops / parallel edges.
 */
function buildGraph(nodes: LensNode[], links: LensLink[]): Graph {
	const ids = new Set<string>();
	const graph = new Graph({ multi: false, type: "undirected" });
	for (const n of nodes) {
		if (!n.id || ids.has(n.id)) continue;
		ids.add(n.id);
		graph.addNode(n.id);
	}
	for (const l of links) {
		if (!ids.has(l.source) || !ids.has(l.target)) continue;
		if (l.source === l.target) continue;
		if (graph.hasEdge(l.source, l.target)) continue;
		graph.addEdge(l.source, l.target);
	}
	return graph;
}

/**
 * Minimum fraction of input nodes that must carry a numeric
 * `properties.louvainCommunity` before the communities lens trusts the server
 * precompute and skips the client-side Louvain run. Below this coverage the
 * precompute is treated as partial/absent (e.g. the #580 precompute hasn't
 * fired yet, or the scope mixes precomputed and fresh nodes) and the lens
 * falls back to computing Louvain in the browser as before. 0.6 = a clear
 * majority — enough that the missing minority rendering uncoloured is honest,
 * not enough to mix two different partitions on one canvas.
 */
export const LOUVAIN_PRECOMPUTE_COVERAGE_THRESHOLD = 0.6;

/** The server-precomputed community id for a node, when present + numeric. */
function precomputedCommunity(node: LensNode): number | null {
	const v = node.properties?.louvainCommunity;
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Louvain partition → nodeId → raw community id (NOT yet palette-mapped).
 *
 * Prefers the server precompute: when at least
 * LOUVAIN_PRECOMPUTE_COVERAGE_THRESHOLD of the input nodes carry a numeric
 * `properties.louvainCommunity` (written by the Louvain precompute run,
 * #580), ids come straight from that property — no client-side Louvain run.
 * Otherwise falls back to computing the partition in the browser.
 *
 * Shared by `communityColors` (palette-maps the ids for rendering) and
 * `communitiesPartitionStats` (reads the RAW ids to judge whether the
 * partition is trivial — the palette wraps at 8 hues, so colour count alone
 * cannot answer that question).
 */
function communityPartition(
	nodes: LensNode[],
	links: LensLink[],
): Map<string, number> {
	const out = new Map<string, number>();
	if (nodes.length === 0) return out;

	// Precompute-preference branch.
	let covered = 0;
	for (const n of nodes) {
		if (precomputedCommunity(n) !== null) covered++;
	}
	if (covered / nodes.length >= LOUVAIN_PRECOMPUTE_COVERAGE_THRESHOLD) {
		for (const n of nodes) {
			const cid = precomputedCommunity(n);
			if (cid === null) continue;
			out.set(n.id, Math.trunc(cid));
		}
		return out;
	}

	// Fallback: client-side Louvain over the loaded subgraph (original path).
	const graph = buildGraph(nodes, links);
	// No edges → no communities to read. Leave the graph in its base styling.
	if (graph.size === 0) return out;
	const partition = louvain(graph) as Record<string, number>;
	for (const n of nodes) {
		const cid = partition[n.id];
		if (cid === undefined) continue;
		out.set(n.id, cid);
	}
	return out;
}

/** Louvain partition → one palette colour per community. */
function communityColors(
	nodes: LensNode[],
	links: LensLink[],
): Map<string, string> {
	const partition = communityPartition(nodes, links);
	const out = new Map<string, string>();
	for (const [id, cid] of partition) {
		// Euclidean-mod so any integer id (including negatives) lands in-palette.
		const idx =
			((cid % COMMUNITY_PALETTE.length) + COMMUNITY_PALETTE.length) %
			COMMUNITY_PALETTE.length;
		out.set(id, COMMUNITY_PALETTE[idx] as string);
	}
	return out;
}

export interface CommunityPartitionStats {
	/** Distinct RAW community ids in the computed partition (pre-palette-wrap;
	 *  the 8-hue palette wraps ids via modulo, so distinct COLOUR count would
	 *  under-count a large partition and over-count nothing — this is the
	 *  number that actually answers "did the recolor find real structure"). */
	communityCount: number;
	/** Nodes that received a community id (via precompute or the client run). */
	coveredNodeCount: number;
}

/**
 * Community partition health for the "communities" lens. Lets callers detect
 * a TRIVIAL partition — one giant community, no edges at all, or every node
 * its own singleton (no real grouping happened) — and show an honest caption
 * instead of a silent no-op recolor, rather than guessing from colour count.
 */
export function communitiesPartitionStats(
	nodes: LensNode[],
	links: LensLink[],
): CommunityPartitionStats {
	const partition = communityPartition(nodes, links);
	return {
		communityCount: new Set(partition.values()).size,
		coveredNodeCount: partition.size,
	};
}

/** True when a communities partition found no real structure to show: no
 *  covered nodes, everything landed in one community, or every covered node
 *  is its own singleton community (average community size ~1). */
export function isTrivialCommunityPartition(
	stats: CommunityPartitionStats,
): boolean {
	return (
		stats.coveredNodeCount === 0 ||
		stats.communityCount <= 1 ||
		stats.communityCount >= stats.coveredNodeCount
	);
}

/**
 * k-core coreness via Batagelj & Zaversnik peeling: repeatedly remove the
 * lowest-degree remaining node; its core number is the running maximum of the
 * removal degrees. Returns nodeId → core number.
 *
 * The naive min-scan peel is O(n²); the app graph is bounded (≤ a few thousand
 * nodes) so this is comfortably fast. If a lens is ever run on a 50k+ graph,
 * swap in the bucket-based O(m) variant.
 */
function coreness(nodes: LensNode[], links: LensLink[]): Map<string, number> {
	const adj = new Map<string, Set<string>>();
	for (const n of nodes) {
		if (!n.id || adj.has(n.id)) continue;
		adj.set(n.id, new Set());
	}
	for (const l of links) {
		if (l.source === l.target) continue;
		const a = adj.get(l.source);
		const b = adj.get(l.target);
		if (!a || !b) continue;
		a.add(l.target);
		b.add(l.source);
	}

	const deg = new Map<string, number>();
	for (const [id, neighbours] of adj) deg.set(id, neighbours.size);

	const core = new Map<string, number>();
	const remaining = new Set(adj.keys());
	let currentCore = 0;
	while (remaining.size > 0) {
		let minId: string | null = null;
		let minDeg = Number.POSITIVE_INFINITY;
		for (const id of remaining) {
			const d = deg.get(id) ?? 0;
			if (d < minDeg) {
				minDeg = d;
				minId = id;
			}
		}
		if (minId === null) break;
		currentCore = Math.max(currentCore, minDeg);
		core.set(minId, currentCore);
		remaining.delete(minId);
		for (const nb of adj.get(minId) ?? []) {
			if (remaining.has(nb)) deg.set(nb, (deg.get(nb) ?? 1) - 1);
		}
	}
	return core;
}

/**
 * Split nodes into core vs periphery by k-core shell and colour each. The split
 * threshold is a simple high-shell cut (top ~40% of shells, floored at k≥2) —
 * an honest k-core reading, not a Borgatti–Everett block-model optimisation.
 */
function corePeripheryColors(
	nodes: LensNode[],
	links: LensLink[],
	theme: LensTheme,
): Map<string, string> {
	const core = coreness(nodes, links);
	const out = new Map<string, string>();
	if (core.size === 0) return out;
	let maxShell = 0;
	for (const v of core.values()) maxShell = Math.max(maxShell, v);
	const threshold = Math.max(2, Math.ceil(maxShell * 0.6));
	const coreHex = CORE_HEX[theme];
	const periphHex = PERIPHERY_HEX[theme];
	for (const n of nodes) {
		const shell = core.get(n.id);
		if (shell === undefined) continue;
		out.set(n.id, shell >= threshold ? coreHex : periphHex);
	}
	return out;
}

/**
 * Compute the per-node colour overrides for a lens. Returns an EMPTY map for
 * "raw" (and whenever the graph is too sparse to read), which leaves every node
 * in its base brand styling — callers should treat an empty map as "no lens".
 */
export function computeLensColors(
	lens: GraphLens,
	nodes: LensNode[],
	links: LensLink[],
	theme: LensTheme = "dark",
): Map<string, string> {
	switch (lens) {
		case "communities":
			return communityColors(nodes, links);
		case "core-periphery":
			return corePeripheryColors(nodes, links, theme);
		default:
			return new Map();
	}
}
