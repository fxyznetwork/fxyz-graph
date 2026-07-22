/**
 * Build a fully-positioned, community-tagged graph slice.
 *
 * Single entrypoint that:
 *   1. Runs two-pass community detection (kind macro + Louvain sub)
 *   2. Computes 3D force-directed positions with community-cluster cohesion
 *   3. Returns a `LandingSubstrateSlice` ready for the R3F mandala renderer
 *
 * Pure function. Server-side only (force layout is CPU-bound; do it once at
 * API time, not per-frame). Output is stable across requests when the input
 * is stable (positions seeded by node id hash).
 */

import type {
	SubstrateData,
	SubstrateEdge,
	SubstrateEdgeKind,
	SubstrateNode,
} from "../types";
import { runCloseLayout2d } from "./close-layout";
import { detectCommunities } from "./community-detection";
import { runForceLayout } from "./force-layout";
import type { LandingSubstrateSlice, PaletteTone } from "./types";

interface BuildOptions {
	radius?: number;
	iterations?: number;
}

/**
 * Defensive normalization. Source data can contain:
 *   - nodes with empty / missing id
 *   - duplicate node ids
 *   - edges referencing unknown source/target ids (orphan relations)
 *
 * Rather than blowing up the whole slice, we drop these inputs at the boundary
 * so the renderer still gets a consistent graph.
 */
function sanitize(data: SubstrateData): {
	nodes: SubstrateNode[];
	edges: SubstrateEdge[];
} {
	const seen = new Set<string>();
	const nodes: SubstrateNode[] = [];
	for (const node of data.nodes) {
		if (!node.id || seen.has(node.id)) continue;
		seen.add(node.id);
		nodes.push(node);
	}
	const edges: SubstrateEdge[] = [];
	for (const edge of data.edges) {
		if (!seen.has(edge.source) || !seen.has(edge.target)) continue;
		edges.push(edge);
	}
	return { nodes, edges };
}

/**
 * Lower-case canonical form for prop-string ↔ node-id matching. Many props
 * carry the country / currency name with inconsistent casing (US Dollar vs
 * United States vs USA vs us) — strip whitespace and lowercase so a single
 * lookup-key approach catches every variant we've seen in prod.
 */
function normalize(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim().toLowerCase();
}

/**
 * Augment the slice with prop-derived structural edges.
 *
 * Many entity kinds (CBDCProject, Indicator, RWAAsset, Partner) carry their
 * structural anchors as **string properties** rather than as explicit graph
 * relationships — so a CBDC node with `country='Brazil'` arrives with zero
 * outgoing edges, and the graph reads as disconnected islands.
 *
 * This pass walks the slice nodes and synthesizes edges from the props
 * themselves: CBDC.country → Country, CBDC.digitalCurrency → Currency,
 * Indicator.country → Country, Partner.jurisdiction → Country,
 * FinancialInstitution.country → Country, RWAAsset.currency → Currency. Each
 * synthesized edge gets a stable id (`synth:<source>:<target>:<kind>`) and a
 * real `SubstrateEdgeKind`. We never overwrite an edge that was already
 * present — a real relationship between two slice nodes always wins.
 *
 * Every synthesized edge corresponds to a structural relationship the entity
 * declares about itself in its own props; this exposes what is already there,
 * it does not invent connections.
 */
/**
 * Hardcoded ISO-2 → name normalization for the common cases the slice carries
 * as a property. Indicator nodes carry `country = "US"` (ISO-2) but a Country
 * node's name is "United States of America", so the lowercase `"us"` lookup
 * misses unless we explicitly normalize. Restricted to the highest-value cases
 * so this stays a pragmatic bridge, not a full ISO library.
 */
const ISO2_TO_NAME: Record<string, string> = {
	us: "united states of america",
	gb: "united kingdom of great britain and northern ireland",
	uk: "united kingdom of great britain and northern ireland",
	de: "germany",
	jp: "japan",
	cn: "china",
	br: "brazil",
	in: "india",
	tr: "türkiye",
	ng: "nigeria",
	mx: "mexico",
	sg: "singapore",
	hk: "hong kong",
	ch: "switzerland",
	ca: "canada",
	au: "australia",
	fr: "france",
	es: "spain",
	it: "italy",
	pl: "poland",
	kr: "korea",
	id: "indonesia",
};

/**
 * Stablecoin issuer → currency code mapping. Partner nodes have names like
 * "Circle" / "Tether" / "Paxos" but no explicit edge to the currency they
 * issue. This map declares the well-known issuer relationships so the slice
 * can render an `ISSUES_CURRENCY` synth edge from each Partner to its currency.
 * Lower-cased Partner name → currency code (case-insensitive). Compiled from
 * public market reports; extend it as new issuers appear.
 *
 * Note: the targets are looked up in `currencyByKey`, which also indexes Asset
 * nodes (USDC/USDT/… ship as kind "Asset", not "Currency") — see
 * synthesizePropEdges. Where a real stablecoin→currency peg edge exists in the
 * source data it carries the peg story directly; this map is the fallback
 * Partner→issued-coin bridge.
 */
const PARTNER_ISSUES_CURRENCY: Record<string, string[]> = {
	circle: ["USDC", "EURC"],
	tether: ["USDT", "EURT"],
	paxos: ["USDP", "PYUSD", "BUSD"],
	"mountain protocol": ["USDM"],
	agora: ["AUSD"],
	bilira: ["TRYB"],
	etherfuse: ["MXNB", "BRZA"],
	transfero: ["BRZ"],
	transferro: ["BRZ"],
	brale: ["BRZ"],
	frax: ["FRAX"],
	makerdao: ["DAI"],
	maker: ["DAI"],
	"sky protocol": ["USDS"],
	sky: ["USDS"],
	ondo: ["USDY"],
	"first digital": ["FDUSD"],
	trueusd: ["TUSD"],
	"trust token": ["TUSD"],
	gemini: ["GUSD"],
	binance: ["BUSD"],
	hashnote: ["USDB"],
};

function synthesizePropEdges(
	nodes: ReadonlyArray<SubstrateNode>,
	edges: ReadonlyArray<SubstrateEdge>,
): SubstrateEdge[] {
	// Index Country and Currency nodes by every plausible match key
	// (id, name, iso3, iso2, code, symbol — all lowercase). Country.name
	// is the most common prop-side reference; Currency uses .code.
	// Asset nodes (USDC, USDT, DAI, …) join the currency lookup in a second
	// pass below — they are what stablecoin-issuing Partners actually issue.
	const countryByKey = new Map<string, SubstrateNode>();
	const currencyByKey = new Map<string, SubstrateNode>();
	const assetNodes: SubstrateNode[] = [];
	for (const node of nodes) {
		if (node.kind === "Asset") {
			assetNodes.push(node);
		} else if (node.kind === "Country") {
			const propName = node.props?.name;
			const nameNorm = normalize(propName ?? node.label);
			const keys = [
				node.id,
				node.label,
				propName,
				node.props?.iso3,
				node.props?.iso2,
			];
			for (const k of keys) {
				const norm = normalize(k);
				if (norm) countryByKey.set(norm, node);
			}
			// Index EVERY Country node by its own ISO-2 code so partner
			// jurisdictions (props.jurisdiction is an ISO-2 like "TR"/"NG"/"AE")
			// resolve for any country the slice carries, not just the ones
			// hardcoded in ISO2_TO_NAME. When a Country node ships its own `iso2`
			// prop, that is the live reverse key. (Also covered incidentally by
			// the `keys` loop above, but kept explicit so the partner-jurisdiction
			// connector survives any future refactor.)
			const liveIso2 = normalize(node.props?.iso2);
			if (liveIso2) countryByKey.set(liveIso2, node);
			// Fallback: reverse-index ISO-2 codes via the hardcoded
			// ISO2_TO_NAME map, superseded by the live index above for any
			// code a Country node carries in props.iso2 — kept for countries
			// whose node ships with a NULL iso2 (the live index can't cover those).
			// E.g. "us" → United States of America node even when iso2 is NULL.
			if (nameNorm) {
				for (const [iso2, name] of Object.entries(ISO2_TO_NAME)) {
					if (name === nameNorm) countryByKey.set(iso2, node);
				}
			}
		} else if (node.kind === "Currency") {
			const keys = [
				node.id,
				node.label,
				node.props?.code,
				node.props?.symbol,
				node.props?.name,
			];
			for (const k of keys) {
				const norm = normalize(k);
				if (norm) currencyByKey.set(norm, node);
			}
		}
	}

	// Second pass — Asset nodes fill the currency lookup WITHOUT overwriting
	// real Currency entries. This revives the PARTNER_ISSUES_CURRENCY bridge:
	// USDC/USDT/… are kind "Asset", so a Currency-only index could never
	// resolve them and every stablecoin-issuing Partner would ship isolated.
	// Asset symbols/codes shouldn't collide with ISO currencies, so the
	// no-overwrite guard is belt-and-suspenders.
	for (const node of assetNodes) {
		const keys = [node.id, node.label, node.props?.symbol, node.props?.name];
		for (const k of keys) {
			const norm = normalize(k);
			if (norm && !currencyByKey.has(norm)) currencyByKey.set(norm, node);
		}
	}

	if (countryByKey.size === 0 && currencyByKey.size === 0) return [];

	// Existing edge keys so we don't duplicate edges already present.
	// Composite key is `${source}|${target}|${kind}`.
	const existing = new Set<string>();
	for (const e of edges) {
		existing.add(`${e.source}|${e.target}|${e.kind}`);
	}

	const synthesized: SubstrateEdge[] = [];
	const addEdge = (
		source: SubstrateNode,
		target: SubstrateNode,
		kind: SubstrateEdgeKind,
	) => {
		if (source.id === target.id) return;
		const key = `${source.id}|${target.id}|${kind}`;
		if (existing.has(key)) return;
		existing.add(key);
		synthesized.push({
			// A stable, deterministic synthetic id for a prop-derived edge.
			id: `synth:${source.id}:${target.id}:${kind}`,
			source: source.id,
			target: target.id,
			kind,
		});
	};

	for (const node of nodes) {
		if (node.kind === "Country" || node.kind === "Currency") continue;
		if (!node.props) continue;
		const props = node.props;

		// country / jurisdiction / homeCountry → Country (IN_COUNTRY).
		// CBDCProject, Indicator, FinancialInstitution, Partner, RWAAsset
		// commonly carry a country prop directly; the prop value is
		// usually the country *name* (e.g. "Brazil", "Nigeria"), not the
		// country *id*, so we match through the lowercased name index.
		const countryCandidates = [
			props.country,
			props.jurisdiction,
			props.homeCountry,
			props.headquarters,
			props.iso3,
			props.iso2,
		];
		for (const cand of countryCandidates) {
			const target = countryByKey.get(normalize(cand));
			if (!target) continue;
			// FinancialInstitution uses HEADQUARTERED_IN as its institution-to-
			// country edge; everything else uses IN_COUNTRY.
			const kind: SubstrateEdgeKind =
				node.kind === "FinancialInstitution"
					? "HEADQUARTERED_IN"
					: "IN_COUNTRY";
			addEdge(node, target, kind);
			break; // one country anchor per node — first match wins
		}

		// digitalCurrency / currency / valuationCurrency / denominatedIn →
		// Currency (USES_CURRENCY). CBDCProject.digitalCurrency is the
		// most common: e.g. "DREX" (Brazil) → Currency node with code DREX.
		// RWAAsset / Partner sometimes carry a currency reference too.
		const currencyCandidates = [
			props.digitalCurrency,
			props.currency,
			props.valuationCurrency,
			props.denominatedIn,
		];
		for (const cand of currencyCandidates) {
			const target = currencyByKey.get(normalize(cand));
			if (!target) continue;
			addEdge(node, target, "USES_CURRENCY");
			break;
		}

		// Partner → Currency: hardcoded issuer map. Partner (stablecoin
		// issuer) nodes often have NO edge to the Currency they issue, so
		// the only way to connect them is a name-based lookup. Each Partner
		// gets an ISSUES_CURRENCY edge to every Currency code in
		// PARTNER_ISSUES_CURRENCY[partner.name.toLowerCase()] that is also
		// present in the slice, so issuers don't render as isolated dust.
		if (node.kind === "Partner") {
			const partnerKey = normalize(node.label ?? node.props?.name ?? node.id);
			const codes = PARTNER_ISSUES_CURRENCY[partnerKey];
			if (codes) {
				for (const code of codes) {
					const cur = currencyByKey.get(normalize(code));
					if (cur) addEdge(node, cur, "ISSUES_CURRENCY");
				}
			}
		}
	}

	return synthesized;
}

export function buildLandingSlice(
	data: SubstrateData,
	options: BuildOptions = {},
): LandingSubstrateSlice {
	const sanitized = sanitize(data);
	const synthesized = synthesizePropEdges(sanitized.nodes, sanitized.edges);
	const nodes = sanitized.nodes;
	const edges =
		synthesized.length === 0
			? sanitized.edges
			: [...sanitized.edges, ...synthesized];

	const { communities, nodeCommunity } = detectCommunities({ nodes, edges });

	const communityTones = new Map<string, PaletteTone>();
	for (const community of communities) {
		communityTones.set(community.id, community.tone);
	}

	const positionedNodes = runForceLayout({
		nodes,
		edges,
		nodeCommunity,
		communityTones,
		radius: options.radius,
		iterations: options.iterations,
	});

	// Deterministic 2D close layout, seeded from the 3D pass's (x, y) so a
	// crossfade descends from the same shape. Per-node `close2d: [x, y]`
	// (2-decimal). Degree-0 nodes are excluded — a missing close2d is the
	// unambiguous "isolated" signal. Bounded fixed-iteration sim; run once
	// server-side (cache the slice if you rebuild it often).
	const close2dById = runCloseLayout2d({ nodes: positionedNodes, edges });
	for (const node of positionedNodes) {
		const close2d = close2dById.get(node.id);
		if (close2d) node.close2d = close2d;
	}

	// meta.counts are recomputed POST-sanitize. Upstream counts may be
	// tallied before sanitize() drops null-id / duplicate nodes and orphan
	// edges, so they could over-report; these counts describe the payload
	// that actually ships (including synthesized prop-edges). Kinds present
	// upstream are kept (at 0 if everything was dropped) so the meta shape
	// stays stable for consumers.
	const counts: Record<string, number> = {};
	for (const key of Object.keys(data.meta?.counts ?? {})) {
		counts[key] = 0;
	}
	for (const node of nodes) {
		counts[node.kind] = (counts[node.kind] ?? 0) + 1;
	}
	counts.edges = edges.length;

	return {
		...data,
		meta: { ...data.meta, counts },
		nodes: positionedNodes,
		edges,
		communities,
		nodeCommunity,
	};
}
