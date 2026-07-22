/**
 * Louvain precompute — the CORE library (session-injected, import-safe for a
 * long-lived server process).
 *
 * This is a session-injected engine meant to be driven by a thin caller (a
 * CLI script or a scheduled route) that owns the Neo4j connection: every
 * function here takes a `Session` and an optional `log` callback and RETURNS
 * structured data — no driver construction, no argv parsing, no
 * `process.exit`, no direct console logging.
 *
 * Import-safety: this module imports only `graphology`,
 * `graphology-communities-louvain`, `./public-graph-limits`, and a TYPE-ONLY
 * `Session` from neo4j-driver (erased at compile — no runtime neo4j-driver
 * dependency pulled into this package). It deliberately does not import any
 * concrete Neo4j client — the caller owns the connection and passes a live
 * `Session`.
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { Session } from "neo4j-driver";
import { computePositions } from "./precompute-positions";
import {
	PUBLIC_GRAPH_PUBLIC_LABELS,
	PUBLIC_GRAPH_SENSITIVE_LABELS,
	publicConceptCypherWhere,
} from "./public-graph-limits";
import { encodeWorkbenchEdgeCache } from "./workbench-edge-cache";

/**
 * Compute slice = the structural public graph. :Observation is excluded from
 * community detection (3.21M time-series leaves as of 2026-07-08 — see the bin
 * header SCOPE note); the write/rollback guard below still uses the FULL
 * allowlist so no non-public node can ever be touched.
 */
export const COMPUTE_LABELS: readonly string[] =
	PUBLIC_GRAPH_PUBLIC_LABELS.filter((l) => l !== "Observation");

const BATCH_SIZE = 5000;
const PROGRESS_EVERY = 500_000;

/**
 * Seed for the Louvain node-visit order (graphology's `options.rng` — defaults
 * to Math.random). Seeding makes the PARTITION deterministic for a given
 * graph, so weekly re-fires on a mostly-unchanged graph keep mostly-unchanged
 * community ids — which, combined with the positions warm-start, keeps the
 * member mental map stable across fires (#580-2).
 */
const LOUVAIN_RNG_SEED = 0xf0e2;

/** mulberry32 — tiny deterministic PRNG in [0, 1). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Round a coordinate to 2 decimals — sub-pixel precision is noise at every
 *  zoom level the consumers render, and shorter floats keep payloads lean. */
function roundCoord(v: number): number {
	return Math.round(v * 100) / 100;
}

/** A fire holding the advisory lock longer than this is presumed dead (a
 *  restart mid-run) and the lock is stealable. Prod fires run single-digit
 *  minutes; 30m is generous. */
const LOCK_STALE_MINUTES = 30;

/**
 * Advisory mutex for the WRITE paths (re-review finding: the summary tier is
 * delete+recreate with no uniqueness constraints — two concurrent fires, e.g.
 * weekly cron + a manual ?force=1 + the bin, would interleave DETACH DELETE
 * and CREATE into duplicated summary nodes). MERGE serializes on the lock
 * node, so exactly one caller sees held=false. A crashed run's lock expires
 * after LOCK_STALE_MINUTES.
 */
async function acquirePrecomputeLock(
	session: Session,
	owner: string,
): Promise<void> {
	const res = await session.run(
		`MERGE (l:GraphPrecomputeLock {id: 'louvain'})
		 WITH l, (l.heldSince IS NOT NULL AND l.heldSince > datetime() - duration('PT${LOCK_STALE_MINUTES}M')) AS held
		 SET l.heldSince = CASE WHEN held THEN l.heldSince ELSE datetime() END,
		     l.heldBy = CASE WHEN held THEN l.heldBy ELSE $owner END
		 RETURN held, l.heldBy AS heldBy`,
		{ owner },
	);
	const rec = res.records[0];
	if (rec?.get("held")) {
		throw new Error(
			`another precompute write holds the louvain lock (heldBy=${String(rec.get("heldBy"))}, younger than ${LOCK_STALE_MINUTES}m) — refusing to interleave`,
		);
	}
}

async function releasePrecomputeLock(session: Session): Promise<void> {
	await session.run(
		`MATCH (l:GraphPrecomputeLock {id: 'louvain'})
		 SET l.heldSince = null, l.heldBy = null`,
	);
}

/** Progress/diagnostic sink. The bin wires console; the route wires its logger. */
export type LouvainLog = (step: string, msg: string) => void;
const NOOP_LOG: LouvainLog = () => {};

/** Per-run RSS peak accumulator (kept per-call so a long-lived server process
 *  never leaks a cumulative peak across invocations). */
interface RssTracker {
	peakBytes: number;
}
function rssGb(t: RssTracker): string {
	const rss = process.memoryUsage().rss;
	if (rss > t.peakBytes) t.peakBytes = rss;
	return `rss=${(rss / 1073741824).toFixed(2)}GB peak=${(t.peakBytes / 1073741824).toFixed(2)}GB`;
}

/** Neo4j Integer | number | string → plain number. */
function asNum(v: unknown): number {
	if (typeof v === "number") return v;
	if (v && typeof (v as { toNumber?: () => number }).toNumber === "function") {
		return (v as { toNumber: () => number }).toNumber();
	}
	return Number(v);
}

/**
 * Cypher label predicate for a node variable, e.g. "n:Currency OR n:Concept OR
 * …". Labels come from code constants (never user input) — safe to interpolate.
 * With PUBLIC_GRAPH_PUBLIC_LABELS this IS the DB-boundary PII guard.
 */
function labelPredicate(varName: string, labels: readonly string[]): string {
	return labels.map((l) => `${varName}:${l}`).join(" OR ");
}

/**
 * Sensitive-label EXCLUSION for a node variable — the allowlist asserts a
 * public label is PRESENT but never that a PII/custody label is ABSENT, so a
 * node co-labeled :Member+:Currency (the mig-537 co-labeling pattern, on a
 * different label family) would pass an OR-only guard. Conjoin this everywhere
 * labelPredicate is used as a boundary (re-review finding, defense in depth).
 */
function sensitiveExclude(varName: string): string {
	return PUBLIC_GRAPH_SENSITIVE_LABELS.map((l) => `NOT ${varName}:${l}`).join(
		" AND ",
	);
}

/** Stream a Cypher result record-by-record — the driver never buffers the set. */
function streamQuery(
	session: Session,
	cypher: string,
	params: Record<string, unknown>,
	onRecord: (rec: { get(key: string): unknown }) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		session.run(cypher, params).subscribe({
			onNext: onRecord,
			onCompleted: () => resolve(),
			onError: reject,
		});
	});
}

/** Streamed slice: nodes interned to integer indices. */
export interface Slice {
	/** index → Neo4j elementId (for write-back + exemplar lookups). */
	ids: string[];
	/** index → position in COMPUTE_LABELS (-1 if somehow none). */
	labelIdx: number[];
	graph: Graph;
	/** index → previous fire's graphX/graphY (warm-start for the positions
	 *  stage — present only for nodes that carried both props). */
	priorPositions?: Map<number, { x: number; y: number }>;
	/**
	 * Directed typed edges retained from the slice stream (tm #1099) — the
	 * workbench payload's edge set, materialized at fire time because the
	 * request-time induced-edge scan costs ~105s on prod (hub expansion
	 * walks millions of observation rels). Deduped by (s,t,type); indexes
	 * into `ids`.
	 */
	typedEdges?: Array<[number, number, number, number | null]>;
	/** Edge-type dictionary for typedEdges' third column. */
	edgeTypes?: string[];
}

/** Stream the public slice (nodes then edges) straight into a graphology graph. */
async function readSlice(
	session: Session,
	log: LouvainLog,
	rss: RssTracker,
): Promise<Slice> {
	const pub: string[] = [...COMPUTE_LABELS];
	const ids: string[] = [];
	const labelIdx: number[] = [];
	const idToIdx = new Map<string, number>();
	const priorPositions = new Map<number, { x: number; y: number }>();
	const graph = new Graph({ multi: false, type: "undirected" });

	await streamQuery(
		session,
		`MATCH (n) WHERE (${labelPredicate("n", COMPUTE_LABELS)}) AND ${sensitiveExclude("n")}
		 RETURN elementId(n) AS id, head([l IN labels(n) WHERE l IN $pub]) AS label,
		        n.graphX AS x, n.graphY AS y`,
		{ pub },
		(rec) => {
			const id = rec.get("id") as string;
			if (!id || idToIdx.has(id)) return;
			const idx = ids.length;
			idToIdx.set(id, idx);
			ids.push(id);
			labelIdx.push(pub.indexOf(rec.get("label") as string));
			graph.addNode(String(idx));
			const px = rec.get("x");
			const py = rec.get("y");
			if (typeof px === "number" && typeof py === "number") {
				priorPositions.set(idx, { x: px, y: py });
			}
			if (ids.length % PROGRESS_EVERY === 0) {
				log("read", `…${ids.length} nodes (${rssGb(rss)})`);
			}
		},
	);
	log(
		"read",
		`${ids.length} nodes (${priorPositions.size} carry prior positions)`,
	);

	let edgeRows = 0;
	const edgeTypes: string[] = [];
	const edgeTypeIdx = new Map<string, number>();
	const typedEdges: Array<[number, number, number, number | null]> = [];
	const typedSeen = new Set<string>();
	await streamQuery(
		session,
		`MATCH (a)-[r]->(b)
		 WHERE (${labelPredicate("a", COMPUTE_LABELS)}) AND ${sensitiveExclude("a")}
		   AND (${labelPredicate("b", COMPUTE_LABELS)}) AND ${sensitiveExclude("b")}
		 RETURN elementId(a) AS source, elementId(b) AS target,
		        type(r) AS type, r.weight AS weight`,
		{},
		(rec) => {
			edgeRows++;
			if (edgeRows % PROGRESS_EVERY === 0) {
				log(
					"read",
					`…${edgeRows} edge rows (${graph.size} unique, ${rssGb(rss)})`,
				);
			}
			const s = idToIdx.get(rec.get("source") as string);
			const t = idToIdx.get(rec.get("target") as string);
			if (s === undefined || t === undefined || s === t) return;
			graph.mergeEdge(String(s), String(t));
			// Typed retention (tm #1099) — first row per (s,t,type) wins.
			const type = String(rec.get("type") ?? "RELATED");
			const key = `${s}|${t}|${type}`;
			if (typedSeen.has(key)) return;
			typedSeen.add(key);
			let ti = edgeTypeIdx.get(type);
			if (ti === undefined) {
				ti = edgeTypes.length;
				edgeTypes.push(type);
				edgeTypeIdx.set(type, ti);
			}
			const w = rec.get("weight");
			typedEdges.push([s, t, ti, typeof w === "number" ? w : null]);
		},
	);
	log(
		"read",
		`${edgeRows} edge rows → ${graph.size} unique undirected, ${typedEdges.length} typed directed`,
	);

	return { ids, labelIdx, graph, priorPositions, typedEdges, edgeTypes };
}

/**
 * Fetch a display name for a handful of exemplar elementIds (only these).
 * Concept-gated like the summary-tier exemplar fetch: these names land in the
 * LOG SINK (console / the cron route's logger → container logs), and an
 * internal notebook/canon Concept title must not leak there either
 * (re-review finding). Gated-out nodes fall back to their elementId.
 */
async function fetchNames(
	session: Session,
	elementIds: string[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (elementIds.length === 0) return out;
	const res = await session.run(
		`MATCH (n) WHERE elementId(n) IN $ids
		   AND (NOT n:Concept OR (${publicConceptCypherWhere("n")}))
		 RETURN elementId(n) AS id,
		        coalesce(n.name, n.title, n.code, n.symbol, n.displayName, n.id, elementId(n)) AS name`,
		{ ids: elementIds },
	);
	for (const rec of res.records) {
		out.set(rec.get("id") as string, String(rec.get("name")));
	}
	return out;
}

/** One community's size distribution — reported via the log sink (diagnostics). */
async function report(
	session: Session,
	slice: Slice,
	communities: Record<string, number>,
	modularity: number,
	count: number,
	log: LouvainLog,
): Promise<{ singletons: number }> {
	const members = new Map<number, number[]>();
	for (const [key, community] of Object.entries(communities)) {
		const list = members.get(community) ?? [];
		list.push(Number(key));
		members.set(community, list);
	}
	const singletons = [...members.values()].filter((m) => m.length === 1).length;
	const top = [...members.entries()]
		.sort((a, b) => b[1].length - a[1].length)
		.slice(0, 10);

	// One name lookup for all exemplars across the top-10 communities.
	const exemplarIds = top.flatMap(([, idxs]) =>
		idxs.slice(0, 3).map((i) => slice.ids[i] as string),
	);
	const names = await fetchNames(session, exemplarIds);

	log("result", `nodes=${slice.graph.order} edges=${slice.graph.size}`);
	log("result", `communities=${count} singletons=${singletons}`);
	log("result", `modularity=${modularity.toFixed(4)}`);
	log("result", "top 10 communities (size · dominant label · exemplars):");
	for (const [community, idxs] of top) {
		const tally = new Map<number, number>();
		for (const i of idxs) {
			const li = slice.labelIdx[i] ?? -1;
			tally.set(li, (tally.get(li) ?? 0) + 1);
		}
		const dominantIdx = [...tally.entries()].sort(
			(a, b) => b[1] - a[1],
		)[0]?.[0];
		const dominant =
			dominantIdx !== undefined && dominantIdx >= 0
				? COMPUTE_LABELS[dominantIdx]
				: "—";
		const exemplars = idxs
			.slice(0, 3)
			.map((i) => names.get(slice.ids[i] as string) ?? slice.ids[i])
			.join(", ");
		log(
			"result",
			`  c${community}\tsize=${idxs.length}\t${dominant}\t[${exemplars}]`,
		);
	}
	return { singletons };
}

/** Community id → member indices, computed once and shared by write + summary. */
function communityMembers(
	communities: Record<string, number>,
): Map<number, number[]> {
	const members = new Map<number, number[]>();
	for (const [key, community] of Object.entries(communities)) {
		const list = members.get(community) ?? [];
		list.push(Number(key));
		members.set(community, list);
	}
	return members;
}

/**
 * ADDITIVE write of louvainCommunity / louvainCommunitySize / louvainComputedAt
 * / graphDegree, batched, allowlist-guarded.
 */
async function writeCommunities(
	session: Session,
	slice: Slice,
	communities: Record<string, number>,
	members: Map<number, number[]>,
	computedAt: string,
	positions: { nodeX: Float64Array; nodeY: Float64Array },
	log: LouvainLog,
): Promise<number> {
	const rows = Object.entries(communities).map(([key, community]) => {
		const idx = Number(key);
		return {
			id: slice.ids[idx] as string,
			community,
			size: members.get(community)?.length ?? 1,
			x: roundCoord(positions.nodeX[idx] ?? 0),
			y: roundCoord(positions.nodeY[idx] ?? 0),
		};
	});
	let updated = 0;
	for (let i = 0; i < rows.length; i += BATCH_SIZE) {
		const chunk = rows.slice(i, i + BATCH_SIZE);
		const res = await session.run(
			// Full PUBLIC allowlist guard (not just COMPUTE_LABELS) — PII defense in
			// depth at the DB boundary; a non-public node can never be written.
			// graphDegree = TRUE total degree (COUNT{} is an O(1) degree-store read
			// per matched node, :Observation leaf edges included) — the same value
			// fullNetworkGraph used to compute per-request at ~7.5s per anon FULL
			// scan; precomputed here so the resolver can ORDER BY the property.
			`UNWIND $rows AS row
			 MATCH (n) WHERE elementId(n) = row.id AND (${labelPredicate("n", PUBLIC_GRAPH_PUBLIC_LABELS)}) AND ${sensitiveExclude("n")}
			 SET n.louvainCommunity = toInteger(row.community),
			     n.louvainCommunitySize = toInteger(row.size),
			     n.louvainComputedAt = datetime($computedAt),
			     n.graphDegree = COUNT { (n)--() },
			     n.graphX = row.x,
			     n.graphY = row.y
			 RETURN count(n) AS updated`,
			{ rows: chunk, computedAt },
		);
		updated += asNum(res.records[0]?.get("updated"));
		if ((i / BATCH_SIZE) % 50 === 0 || i + BATCH_SIZE >= rows.length) {
			log("write", `${updated}/${rows.length} nodes set`);
		}
	}
	return updated;
}

/** One summary node of the two-tier LOD (community super-node or label bucket). */
interface SummaryNode {
	id: string;
	kind: "community" | "label-bucket";
	communityId?: number;
	bucketLabel?: string;
	size: number;
	dominantLabel: string;
	/** Top slice-degree member elementIds — name-resolved (gated) at write time. */
	exemplarCandidateIds: string[];
}

interface SummaryTier {
	nodes: SummaryNode[];
	links: Array<{ source: string; target: string; weight: number }>;
}

/**
 * Build the two-tier summary in memory from the already-computed slice:
 * community super-nodes for size≥2 communities, label-bucket super-nodes for
 * the singleton tail, and aggregated inter-summary edge weights.
 */
function buildSummaryTier(
	slice: Slice,
	members: Map<number, number[]>,
): SummaryTier {
	const summaryKeyByIdx = new Map<number, string>();
	const nodes: SummaryNode[] = [];
	const buckets = new Map<string, number>(); // label → singleton count

	const dominantLabelOf = (idxs: number[]): string => {
		const tally = new Map<number, number>();
		for (const i of idxs) {
			const li = slice.labelIdx[i] ?? -1;
			tally.set(li, (tally.get(li) ?? 0) + 1);
		}
		const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
		return top !== undefined && top >= 0
			? (COMPUTE_LABELS[top] as string)
			: "Unknown";
	};

	for (const [community, idxs] of members) {
		if (idxs.length >= 2) {
			const id = `louvain-community-${community}`;
			// Exemplars ranked by slice-internal degree (structural centrality
			// within the community) — the display-name fetch at write time applies
			// the public-Concept gate, so candidates are over-sampled here.
			const ranked = [...idxs].sort(
				(a, b) => slice.graph.degree(String(b)) - slice.graph.degree(String(a)),
			);
			nodes.push({
				id,
				kind: "community",
				communityId: community,
				size: idxs.length,
				dominantLabel: dominantLabelOf(idxs),
				// 25 candidates, not 10 (#1056): Concept-dominated communities lose
				// most candidates to the public-Concept gate at name-fetch time —
				// a deeper pool lets a public concept further down the degree
				// ranking name the community instead of "<label> cluster".
				exemplarCandidateIds: ranked
					.slice(0, 25)
					.map((i) => slice.ids[i] as string),
			});
			for (const i of idxs) summaryKeyByIdx.set(i, id);
		} else {
			const idx = idxs[0] as number;
			const li = slice.labelIdx[idx] ?? -1;
			const label = li >= 0 ? (COMPUTE_LABELS[li] as string) : "Unknown";
			buckets.set(label, (buckets.get(label) ?? 0) + 1);
			summaryKeyByIdx.set(idx, `label-bucket-${label}`);
		}
	}

	for (const [label, count] of buckets) {
		nodes.push({
			id: `label-bucket-${label}`,
			kind: "label-bucket",
			bucketLabel: label,
			size: count,
			dominantLabel: label,
			exemplarCandidateIds: [],
		});
	}

	// Aggregate inter-summary edge weights from the in-memory slice graph.
	const weights = new Map<string, number>();
	slice.graph.forEachEdge((_edge, _attrs, source, target) => {
		const a = summaryKeyByIdx.get(Number(source));
		const b = summaryKeyByIdx.get(Number(target));
		if (!a || !b || a === b) return;
		const key = a < b ? `${a} ${b}` : `${b} ${a}`;
		weights.set(key, (weights.get(key) ?? 0) + 1);
	});
	const links = [...weights.entries()].map(([key, weight]) => {
		const [source, target] = key.split(" ") as [string, string];
		return { source, target, weight };
	});

	return { nodes, links };
}

/**
 * Persist the summary tier. The tier is a DERIVED CACHE (regenerated wholesale
 * every fire, like re-stamping louvainCommunity) — refresh = delete + create.
 */
async function writeSummaryTier(
	session: Session,
	tier: SummaryTier,
	computedAt: string,
	summaryPositions: Map<string, { x: number; y: number; r: number }>,
	overviewPositions: Map<string, { x: number; y: number }>,
	log: LouvainLog,
): Promise<void> {
	// Resolve exemplar display names BEFORE deleting the live tier — live
	// resolvers serve :GraphCommunity throughout the fire, so the empty window
	// must be delete→create only, never delete→(name lookups)→create
	// (re-review finding: mid-fire serving gap). Names use the SAME
	// public-Concept gate the resolvers use — an internal notebook/canon
	// Concept title must never become a public super-node name.
	const allCandidates = tier.nodes.flatMap((n) => n.exemplarCandidateIds);
	const names = new Map<string, string>();
	for (let i = 0; i < allCandidates.length; i += BATCH_SIZE) {
		const chunk = allCandidates.slice(i, i + BATCH_SIZE);
		// NOT n:SanctionedEntity — OFAC SDN entries carry real person names; a
		// sanctions-dominated community must fall back to "<label> cluster"
		// naming rather than headline individuals on the public Overview
		// (re-review finding).
		const res = await session.run(
			`MATCH (n) WHERE elementId(n) IN $ids
			   AND NOT n:SanctionedEntity
			   AND (NOT n:Concept OR (${publicConceptCypherWhere("n")}))
			 RETURN elementId(n) AS id,
			        coalesce(n.name, n.title, n.code, n.symbol, n.displayName, n.label) AS name`,
			{ ids: chunk },
		);
		for (const rec of res.records) {
			const name = rec.get("name");
			if (name) names.set(rec.get("id") as string, String(name));
		}
	}

	await session.run(`MATCH (c:GraphCommunity) DETACH DELETE c`);

	const rows = tier.nodes.map((n) => {
		const exemplars = n.exemplarCandidateIds
			.map((id) => names.get(id))
			.filter((x): x is string => Boolean(x))
			.slice(0, 3);
		const pos = summaryPositions.get(n.id);
		const ov = overviewPositions.get(n.id);
		return {
			// Numeric fields travel OUTSIDE props and get toInteger()'d in Cypher —
			// the driver writes bare JS numbers as Float.
			size: n.size,
			communityId: n.communityId ?? null,
			// Precomputed layout centroid + disc radius (#580-2). Floats are the
			// CORRECT type here, so they ride as bare numbers (driver → Float).
			x: pos ? roundCoord(pos.x) : null,
			y: pos ? roundCoord(pos.y) : null,
			r: pos ? roundCoord(pos.r) : null,
			// Render-scale overview position (tm #1080) — world x/y stays the
			// member-containment layout; the overview route prefers ovX/ovY.
			ovX: ov ? roundCoord(ov.x) : null,
			ovY: ov ? roundCoord(ov.y) : null,
			props: {
				id: n.id,
				kind: n.kind,
				...(n.bucketLabel !== undefined ? { bucketLabel: n.bucketLabel } : {}),
				dominantLabel: n.dominantLabel,
				exemplars,
				name:
					n.kind === "label-bucket"
						? n.dominantLabel
						: exemplars.length > 0
							? exemplars.join(" · ")
							: `${n.dominantLabel} cluster`,
			},
		};
	});
	for (let i = 0; i < rows.length; i += BATCH_SIZE) {
		await session.run(
			`UNWIND $rows AS row
			 CREATE (c:GraphCommunity)
			 SET c += row.props,
			     c.size = toInteger(row.size),
			     c.communityId = CASE WHEN row.communityId IS NULL THEN null ELSE toInteger(row.communityId) END,
			     c.x = row.x,
			     c.y = row.y,
			     c.r = row.r,
			     c.ovX = row.ovX,
			     c.ovY = row.ovY,
			     c.computedAt = datetime($computedAt)`,
			{ rows: rows.slice(i, i + BATCH_SIZE), computedAt },
		);
	}
	log("summary", `${rows.length} :GraphCommunity nodes written`);

	for (let i = 0; i < tier.links.length; i += BATCH_SIZE) {
		await session.run(
			`UNWIND $rows AS row
			 MATCH (a:GraphCommunity {id: row.source}), (b:GraphCommunity {id: row.target})
			 CREATE (a)-[r:GRAPH_COMMUNITY_LINK]->(b)
			 SET r.weight = toInteger(row.weight), r.computedAt = datetime($computedAt)`,
			{ rows: tier.links.slice(i, i + BATCH_SIZE), computedAt },
		);
	}
	log("summary", `${tier.links.length} :GRAPH_COMMUNITY_LINK edges written`);
}

// ---------------------------------------------------------------------------
// Observation LOD (tm #913 / W3-3) — source super-nodes + series summaries.
//
// The 3.21M :Observation time-series leaves are excluded from Louvain (single-
// link leaves — modularity is meaningless on them). This pass aggregates them by
// the indexed sourceId/indicatorId PROPERTIES (never edge traversal, mig 070)
// into ~27 source super-nodes (Tier A — reuses :GraphCommunity with a new kind)
// + a bounded series-summary tier (Tier B — :ObservationSeriesSummary: top-300
// series/source + one long-tail bucket/source). Design:
// docs/audits/2026-07-12-observation-lod-design.md §2-4. Raw observations never
// render — this tier IS the surface.
// ---------------------------------------------------------------------------

/** Top series per source persisted as their own summary node; the rest fold into
 *  one long-tail bucket (matches the existing expand cap; D4). */
const TOP_SERIES_PER_SOURCE = 300;

/**
 * Observation-family labels (D7). A row carrying ONLY these is a pure leaf; a row
 * carrying any label outside the family is label-bleed (finnhub/dune SET
 * :Observation onto Equity/DeFiProtocol/… entity nodes — the mig 537 pattern,
 * still live) and is dropped from the aggregation. Enumerated from the writer
 * federation: base + the price/economic families + the BIS sub-shapes
 * (bis-sync.ts) + QuarantinedObservation (mig 566).
 */
const OBSERVATION_FAMILY_LABELS: ReadonlySet<string> = new Set([
	"Observation",
	"PriceObservation",
	"EconomicObservation",
	"FXMarketData",
	"PolicyRate",
	"QuarantinedObservation",
	"BISOTCDerivative",
	"BISCentralBankAssets",
	"BISConsumerPrice",
	"BISCreditData",
	"RealEstateIndex",
	"DebtServiceRatio",
]);

/** D7 predicate: true when every label is in the observation family (pure leaf);
 *  false when the row carries a bleed label. Exported for unit tests. */
export function isObservationLeafRow(labels: readonly string[]): boolean {
	for (const l of labels) {
		if (!OBSERVATION_FAMILY_LABELS.has(l)) return false;
	}
	return labels.length > 0;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function isoDayFromEpoch(raw: number): string | null {
	if (!Number.isFinite(raw) || raw <= 0) return null;
	// < 1e12 → epoch seconds (the year-2001 boundary); else epoch milliseconds.
	const ms = raw < 1e12 ? raw * 1000 : raw;
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function coerceDayToken(v: unknown): string | null {
	if (v == null) return null;
	if (typeof v === "string") {
		const s = v.trim();
		if (!s) return null;
		return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
	}
	if (typeof v === "object") {
		const o = v as {
			year?: unknown;
			month?: unknown;
			day?: unknown;
			toString?: () => string;
		};
		if (o.year != null && o.month != null && o.day != null) {
			return `${asNum(o.year)}-${pad2(asNum(o.month))}-${pad2(asNum(o.day))}`;
		}
		if (typeof o.toString === "function") {
			const s = o.toString().trim();
			if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
		}
	}
	return null;
}

function coercePeriodToken(v: unknown): string | null {
	if (v == null) return null;
	if (typeof v === "string") return v.trim() || null;
	if (
		typeof v === "object" &&
		typeof (v as { toString?: () => string }).toString === "function"
	) {
		return (v as { toString: () => string }).toString().trim() || null;
	}
	return null;
}

function coerceTimestampToken(v: unknown): string | null {
	if (v == null) return null;
	if (typeof v === "number") return isoDayFromEpoch(v);
	if (typeof v === "string") {
		const s = v.trim();
		if (!s) return null;
		if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
		const n = Number(s);
		return Number.isFinite(n) ? isoDayFromEpoch(n) : null;
	}
	if (typeof v === "object") {
		const o = v as { toNumber?: () => number; toString?: () => string };
		if (typeof o.toNumber === "function") return isoDayFromEpoch(o.toNumber());
		if (typeof o.toString === "function") {
			const s = o.toString().trim();
			if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
		}
	}
	return null;
}

/**
 * D8 time normalization: `date ?? period ?? ISO-day(timestamp)` → a comparable
 * day/period token, or null when the row carries no time. Handles the three
 * divergent time shapes (`.date` FRED/EIA/Treasury · `.period` DBnomics/OECD/
 * IMF/BIS · `.timestamp` PriceObservation) AND the driver's temporal/Integer
 * wrappers. Per-series the token is homogeneous (one writer family), so the
 * min/max firstAt/lastAt compare lexicographically. Exported for unit tests.
 */
export function normalizeObservationTime(
	date: unknown,
	period: unknown,
	timestamp: unknown,
): string | null {
	return (
		coerceDayToken(date) ??
		coercePeriodToken(period) ??
		coerceTimestampToken(timestamp)
	);
}

/**
 * Provider display names for the known source ids (price-sources.ts registry).
 * Acronym providers stay uppercase; the rest carry their conventional casing.
 * Unknown ids fall back to a light title-case of the id (D12). The Tier A
 * super-node `name` is `"<display> observations"` so resolveNodeLabel works
 * untouched.
 */
const PROVIDER_DISPLAY: Readonly<Record<string, string>> = {
	defillama: "DefiLlama",
	defillama_coins: "DefiLlama Coins",
	defillama_chains: "DefiLlama Chains",
	coingecko: "CoinGecko",
	coingecko_exchanges: "CoinGecko Exchanges",
	pyth: "Pyth",
	frankfurter: "Frankfurter",
	bis: "BIS",
	bridge: "Bridge",
	rwa: "RWA",
	cbdc_tracker: "CBDC Tracker",
	fred: "FRED",
	imf: "IMF",
	dbnomics: "DBnomics",
	eia: "EIA",
	finnhub: "Finnhub",
	treasury: "Treasury",
	cryptocompare: "CryptoCompare",
	dune: "Dune",
	oecd: "OECD",
	fdic: "FDIC",
	twelvedata: "TwelveData",
	bluechip: "Bluechip",
	ofac: "OFAC",
	circle: "Circle",
	fawazahmed0: "Fawazahmed0",
	currencybeacon: "CurrencyBeacon",
};

/** Humanize a source id to a provider display name (D12). Exported for tests. */
export function providerDisplayName(sourceId: string): string {
	const known = PROVIDER_DISPLAY[sourceId.toLowerCase()];
	if (known) return known;
	return (
		sourceId
			.split(/[_-]+/)
			.filter(Boolean)
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ") || sourceId
	);
}

/** Light humanization of an indicator id for the series-summary displayName (D4)
 *  — underscores to spaces, no invented metadata. */
function humanizeIndicator(indicatorId: string): string {
	return indicatorId.replace(/_/g, " ").trim() || indicatorId;
}

interface ObservationSeriesAcc {
	count: number;
	firstAt: string | null;
	lastAt: string | null;
	/** rows in this series with no normalizable time (D8). */
	unknownWindow: number;
}

interface ObservationSourceAcc {
	/** all leaf rows for this source (→ Tier A size), incl. rows with no indicatorId. */
	total: number;
	series: Map<string, ObservationSeriesAcc>;
}

interface ObservationAggregate {
	sources: Map<string, ObservationSourceAcc>;
	/** rows dropped by the D7 bleed filter. */
	bleedDropped: number;
	/** rows with a null/empty sourceId — dropped from aggregation (contract 2). */
	unattributed: number;
	/** rows with no normalizable time across all series (D8). */
	unknownWindow: number;
	/** total leaf rows aggregated (sum of source totals) = represented count. */
	represented: number;
}

/**
 * Stream every :Observation leaf and reduce (in Node) into per-source/per-series
 * accumulators. The stream never buffers the 3.21M rows; the memory bound is the
 * distinct (source, series) pair count, not the row count. Read-only — safe in
 * dry-run and fire alike.
 */
async function aggregateObservations(
	session: Session,
	log: LouvainLog,
	rss: RssTracker,
): Promise<ObservationAggregate> {
	const sources = new Map<string, ObservationSourceAcc>();
	let bleedDropped = 0;
	let unattributed = 0;
	let unknownWindow = 0;
	let represented = 0;
	let seen = 0;

	await streamQuery(
		session,
		`MATCH (o:Observation)
		 RETURN o.sourceId AS sourceId, o.indicatorId AS indicatorId, labels(o) AS labels,
		        o.date AS date, o.period AS period, o.timestamp AS timestamp`,
		{},
		(rec) => {
			seen++;
			if (seen % PROGRESS_EVERY === 0) {
				log(
					"observation",
					`…${seen} rows (${sources.size} sources, ${rssGb(rss)})`,
				);
			}
			const labels = (rec.get("labels") as string[]) ?? [];
			if (!isObservationLeafRow(labels)) {
				bleedDropped++;
				return;
			}
			const rawSource = rec.get("sourceId");
			if (rawSource == null || rawSource === "") {
				unattributed++;
				return;
			}
			const sid = String(rawSource);
			let src = sources.get(sid);
			if (!src) {
				src = { total: 0, series: new Map() };
				sources.set(sid, src);
			}
			src.total++;
			represented++;

			const time = normalizeObservationTime(
				rec.get("date"),
				rec.get("period"),
				rec.get("timestamp"),
			);
			if (time === null) unknownWindow++;

			const rawIndicator = rec.get("indicatorId");
			// A source-attributed row with no indicatorId still counts toward the
			// source total (Tier A size), but is not its own series.
			if (rawIndicator == null || rawIndicator === "") return;
			const iid = String(rawIndicator);
			let ser = src.series.get(iid);
			if (!ser) {
				ser = { count: 0, firstAt: null, lastAt: null, unknownWindow: 0 };
				src.series.set(iid, ser);
			}
			ser.count++;
			if (time === null) {
				ser.unknownWindow++;
			} else {
				if (ser.firstAt === null || time < ser.firstAt) ser.firstAt = time;
				if (ser.lastAt === null || time > ser.lastAt) ser.lastAt = time;
			}
		},
	);
	log(
		"observation",
		`${seen} rows → ${sources.size} sources, ${represented} leaves represented (bleed ${bleedDropped}, unattributed ${unattributed}, unknown-window ${unknownWindow})`,
	);
	return { sources, bleedDropped, unattributed, unknownWindow, represented };
}

/** Tier B node count a fire WOULD write (top-N + long-tail per source). */
function planSeriesSummaryCount(agg: ObservationAggregate): number {
	let total = 0;
	for (const src of agg.sources.values()) {
		const n = src.series.size;
		total +=
			Math.min(n, TOP_SERIES_PER_SOURCE) + (n > TOP_SERIES_PER_SOURCE ? 1 : 0);
	}
	return total;
}

interface ObservationWriteResult {
	sourcesWritten: number;
	seriesSummariesWritten: number;
	linksCreated: number;
	linksSkipped: number;
}

/**
 * Persist Tier A (:GraphCommunity kind='observation-source') + Tier B
 * (:ObservationSeriesSummary, delete+recreate) + the D3 links. Tier A nodes are
 * :GraphCommunity, so writeSummaryTier's DETACH DELETE (earlier in this same
 * fire) already cleared the prior run's Tier A — this only clears Tier B.
 */
async function writeObservationTiers(
	session: Session,
	agg: ObservationAggregate,
	computedAt: string,
	log: LouvainLog,
): Promise<ObservationWriteResult> {
	await session.run(`MATCH (s:ObservationSeriesSummary) DETACH DELETE s`);

	const sourceIds = [...agg.sources.keys()];

	// Tier A — one source super-node per provider. Numeric fields travel OUTSIDE
	// props and get toInteger()'d in Cypher (the driver writes bare JS numbers as
	// Float), same convention as writeSummaryTier.
	const tierARows = sourceIds.map((sid) => {
		const src = agg.sources.get(sid) as ObservationSourceAcc;
		return {
			size: src.total,
			seriesCount: src.series.size,
			props: {
				id: `observation-source-${sid}`,
				kind: "observation-source",
				sourceId: sid,
				dominantLabel: "Observation",
				name: `${providerDisplayName(sid)} observations`,
			},
		};
	});
	for (let i = 0; i < tierARows.length; i += BATCH_SIZE) {
		await session.run(
			`UNWIND $rows AS row
			 CREATE (c:GraphCommunity)
			 SET c += row.props,
			     c.size = toInteger(row.size),
			     c.seriesCount = toInteger(row.seriesCount),
			     c.computedAt = datetime($computedAt)`,
			{ rows: tierARows.slice(i, i + BATCH_SIZE), computedAt },
		);
	}
	log(
		"observation",
		`${tierARows.length} :GraphCommunity observation-source nodes written`,
	);

	// Tier B — top-N series per source + one long-tail bucket carrying the remainder.
	const tierBRows: Array<{
		count: number;
		seriesCount: number | null;
		props: Record<string, string>;
	}> = [];
	for (const sid of sourceIds) {
		const src = agg.sources.get(sid) as ObservationSourceAcc;
		const ranked = [...src.series.entries()].sort(
			(a, b) => b[1].count - a[1].count,
		);
		for (const [iid, ser] of ranked.slice(0, TOP_SERIES_PER_SOURCE)) {
			tierBRows.push({
				count: ser.count,
				seriesCount: null,
				props: {
					id: `obs-series-${sid}-${iid}`,
					sourceId: sid,
					indicatorId: iid,
					displayName: humanizeIndicator(iid),
					...(ser.firstAt !== null ? { firstAt: ser.firstAt } : {}),
					...(ser.lastAt !== null ? { lastAt: ser.lastAt } : {}),
				},
			});
		}
		const remainder = ranked.slice(TOP_SERIES_PER_SOURCE);
		if (remainder.length > 0) {
			tierBRows.push({
				count: remainder.reduce((s, [, ser]) => s + ser.count, 0),
				seriesCount: remainder.length,
				props: {
					id: `obs-longtail-${sid}`,
					kind: "observation-longtail",
					sourceId: sid,
				},
			});
		}
	}
	for (let i = 0; i < tierBRows.length; i += BATCH_SIZE) {
		await session.run(
			`UNWIND $rows AS row
			 CREATE (s:ObservationSeriesSummary)
			 SET s += row.props,
			     s.count = toInteger(row.count),
			     s.seriesCount = CASE WHEN row.seriesCount IS NULL THEN null ELSE toInteger(row.seriesCount) END,
			     s.computedAt = datetime($computedAt)`,
			{ rows: tierBRows.slice(i, i + BATCH_SIZE), computedAt },
		);
	}
	log(
		"observation",
		`${tierBRows.length} :ObservationSeriesSummary nodes written`,
	);

	// D3 — link each source super-node into the community graph via its provider's
	// louvainCommunity, with a label-bucket FALLBACK: provider nodes are almost
	// always Louvain SINGLETONS (their edges point at the excluded :Observation
	// leaves, so they have no structural edges inside the compute slice — first
	// prod fire 2026-07-12: 15 of 16 providers were singletons). A singleton's
	// summary representation IS its label bucket, so linking there is exact, not a
	// hack. Only when neither a community super-node nor a matching bucket exists
	// does the row drop, counted as skipped.
	const linkRes = await session.run(
		`UNWIND $sourceIds AS sid
		 MATCH (super:GraphCommunity {id: 'observation-source-' + sid})
		 OPTIONAL MATCH (p) WHERE (p:PriceSource OR p:DataSource) AND p.id = sid AND p.louvainCommunity IS NOT NULL
		 WITH super, collect(p)[0] AS prov
		 OPTIONAL MATCH (comm:GraphCommunity {kind: 'community'}) WHERE prov IS NOT NULL AND comm.communityId = prov.louvainCommunity
		 WITH super, prov, collect(comm)[0] AS comm
		 OPTIONAL MATCH (bucket:GraphCommunity {kind: 'label-bucket'}) WHERE prov IS NOT NULL AND bucket.bucketLabel IN labels(prov)
		 WITH super, comm, collect(bucket)[0] AS bkt
		 WITH super, coalesce(comm, bkt) AS target
		 WHERE target IS NOT NULL
		 CREATE (super)-[r:GRAPH_COMMUNITY_LINK]->(target)
		 SET r.weight = toInteger(1), r.computedAt = datetime($computedAt)
		 RETURN count(*) AS linked`,
		{ sourceIds, computedAt },
	);
	const linksCreated = asNum(linkRes.records[0]?.get("linked"));
	const linksSkipped = sourceIds.length - linksCreated;
	log(
		"observation",
		`${linksCreated} source→community links written, ${linksSkipped} unlinked (no provider/community)`,
	);

	return {
		sourcesWritten: tierARows.length,
		seriesSummariesWritten: tierBRows.length,
		linksCreated,
		linksSkipped,
	};
}

/** Read-only dry-run probe: how many sources WOULD link — to their provider's
 *  community super-node, or (the dominant case: providers are Louvain
 *  singletons) to the provider's label bucket. Mirrors the fire-path fallback. */
async function probeObservationLinkable(
	session: Session,
	sourceIds: string[],
): Promise<number> {
	if (sourceIds.length === 0) return 0;
	const res = await session.run(
		`UNWIND $sourceIds AS sid
		 OPTIONAL MATCH (p) WHERE (p:PriceSource OR p:DataSource) AND p.id = sid AND p.louvainCommunity IS NOT NULL
		 WITH sid, collect(p)[0] AS prov
		 OPTIONAL MATCH (comm:GraphCommunity {kind: 'community'}) WHERE prov IS NOT NULL AND comm.communityId = prov.louvainCommunity
		 WITH sid, prov, collect(comm)[0] AS comm
		 OPTIONAL MATCH (bucket:GraphCommunity {kind: 'label-bucket'}) WHERE prov IS NOT NULL AND bucket.bucketLabel IN labels(prov)
		 WITH sid, comm, collect(bucket)[0] AS bkt
		 WITH sid, coalesce(comm, bkt) AS target
		 WHERE target IS NOT NULL
		 RETURN count(*) AS linkable`,
		{ sourceIds },
	);
	return asNum(res.records[0]?.get("linkable"));
}

// ---------------------------------------------------------------------------
// Public API — session-injected, structured returns.
// ---------------------------------------------------------------------------

export interface LouvainPrecomputeResult {
	mode: "fire" | "dry-run";
	nodes: number;
	edges: number;
	communities: number;
	singletons: number;
	modularity: number;
	/** total :GraphCommunity super-nodes planned (fire) or that WOULD be written (dry). */
	summaryNodes: number;
	summaryCommunityNodes: number;
	summaryBuckets: number;
	summaryLinks: number;
	/** Observation LOD (tm #913): source super-nodes written (fire) or planned (dry). */
	observationSources: number;
	/** :ObservationSeriesSummary nodes written (fire) or planned (dry) — top-N + long-tail. */
	observationSeriesSummaries: number;
	/** total :Observation leaves represented by the source super-nodes (sum of Tier A size). */
	representedObservations: number;
	/** rows dropped by the D7 bleed filter (finnhub/dune entity-node label-bleed). */
	observationBleedDropped: number;
	/** rows with a null/empty sourceId, dropped from aggregation. */
	observationUnattributed: number;
	/** rows with no normalizable time (D8). */
	observationUnknownWindow: number;
	/** D3 source→community links created (fire) or linkable (dry). */
	observationLinks: number;
	/** sources with no provider/community to link (honest degrade). */
	observationLinksSkipped: number;
	/** only on fire — count of nodes that got the additive props. */
	nodesWritten?: number;
	/** only on fire — the single ISO stamp shared by node props + summary tier. */
	computedAt?: string;
	/** Positions stage (#580-2): every slice node gets graphX/graphY. */
	positionedNodes: number;
	/** members laid out via per-community force sims. */
	positionsForce: number;
	/** members laid out via the deterministic phyllotaxis fallback. */
	positionsPhyllotaxis: number;
	/** nodes neither pass reached (parked near origin) — MUST be 0; nonzero
	 *  means partition/summary drift. */
	positionsUnpositioned: number;
	/** nodes that seeded from the previous fire's coordinates (warm start). */
	positionsWarmStarted: number;
	positionsWallMs: number;
	wallMs: number;
	peakRssBytes: number;
}

/**
 * Read → Louvain → (optionally) write. With `fire:false` this reads + computes +
 * reports and writes NOTHING (the bin's dry-run). With `fire:true` it writes the
 * additive node props AND refreshes the :GraphCommunity summary tier under ONE
 * shared timestamp. Throws on an empty slice (nothing to compute).
 */
// Codec extracted to its own dep-free module (tm #1134) so the API-side
// reader can import/test it without pulling the precompute engine. Re-export
// keeps the existing `@fxyz/graph-layout/precompute-louvain` surface intact.
export {
	decodeWorkbenchEdgeCache,
	encodeWorkbenchEdgeCache,
	type WorkbenchCacheEdge,
} from "./workbench-edge-cache";

/** Persist the slice's typed edge set (tm #1099) — one singleton node,
 *  replaced per fire; the workbench route serves edges from it instead of
 *  re-scanning induced rels per request (~105s measured on prod). */
async function writeWorkbenchEdgeCache(
	session: Session,
	slice: Slice,
	computedAt: string,
	log: LouvainLog,
): Promise<number> {
	const { payload, edgeCount } = encodeWorkbenchEdgeCache(slice);
	await session.run(
		`MERGE (c:WorkbenchEdgeCache {id: 'workbench-edges'})
		 SET c.computedAt = $computedAt, c.payload = $payload,
		     c.edgeCount = $edgeCount, c.nodeCount = $nodeCount`,
		{
			computedAt,
			payload,
			edgeCount,
			nodeCount: slice.ids.length,
		},
	);
	log("write", `workbench edge cache: ${edgeCount} typed edges`);
	return edgeCount;
}

export async function runLouvainPrecompute(
	session: Session,
	opts?: { fire?: boolean; log?: LouvainLog },
): Promise<LouvainPrecomputeResult> {
	const fire = opts?.fire ?? false;
	// Fire takes the advisory lock BEFORE the expensive read — a second
	// concurrent fire fails fast instead of burning minutes of compute and
	// interleaving delete+recreate writes. Dry-run never locks (read-only).
	if (!fire) return runLouvainPrecomputeInner(session, opts);
	await acquirePrecomputeLock(session, "louvain-precompute-fire");
	try {
		return await runLouvainPrecomputeInner(session, opts);
	} finally {
		await releasePrecomputeLock(session);
	}
}

async function runLouvainPrecomputeInner(
	session: Session,
	opts?: { fire?: boolean; log?: LouvainLog },
): Promise<LouvainPrecomputeResult> {
	const fire = opts?.fire ?? false;
	const log = opts?.log ?? NOOP_LOG;
	const rss: RssTracker = { peakBytes: 0 };
	const t0 = Date.now();

	log(
		"read",
		`streaming structural public slice (${COMPUTE_LABELS.length} labels — :Observation excluded)…`,
	);
	const slice = await readSlice(session, log, rss);
	if (slice.graph.order === 0) {
		throw new Error("no public nodes found — nothing to compute");
	}

	log("compute", "running Louvain…");
	// Seeded rng → deterministic partition for a given graph (see
	// LOUVAIN_RNG_SEED). A fresh generator per run — never a shared one, so a
	// long-lived server process gets the same sequence every invocation.
	const { communities, count, modularity } = louvain.detailed(slice.graph, {
		rng: mulberry32(LOUVAIN_RNG_SEED),
	});
	const { singletons } = await report(
		session,
		slice,
		communities,
		modularity,
		count,
		log,
	);
	log("result", `wall=${((Date.now() - t0) / 1000).toFixed(1)}s ${rssGb(rss)}`);

	const members = communityMembers(communities);
	const tier = buildSummaryTier(slice, members);
	const communityNodes = tier.nodes.filter(
		(n) => n.kind === "community",
	).length;
	log(
		"summary",
		`two-tier plan: ${communityNodes} community super-nodes + ${tier.nodes.length - communityNodes} label buckets = ${tier.nodes.length} top-level nodes, ${tier.links.length} aggregated links`,
	);

	// Positions stage (#580-2) — hierarchical deterministic layout: summary
	// discs first, members inside their disc, singletons in their label bucket.
	// Runs in BOTH modes so dry-run reports honest stats; yields to the event
	// loop between community sub-sims (the cron route runs in the serving
	// container). Warm-starts from the previous fire's graphX/graphY.
	log(
		"positions",
		`computing hierarchical layout (${slice.priorPositions?.size ?? 0} warm-start priors)…`,
	);
	const positions = await computePositions({
		slice,
		members,
		summaryNodes: tier.nodes,
		summaryLinks: tier.links,
		priorPositions: slice.priorPositions,
	});
	log(
		"positions",
		`${positions.forceLaidOut} force + ${positions.phyllotaxisLaidOut} phyllotaxis, unpositioned=${positions.unpositioned}, wall=${(positions.wallMs / 1000).toFixed(1)}s (${rssGb(rss)})`,
	);

	// Observation LOD pass (tm #913) — aggregate the 3.21M :Observation leaves by
	// source/series. Read-only stream; runs in BOTH modes so dry-run reports the
	// same numbers. Writes happen only on fire, AFTER the structural summary tier.
	log(
		"observation",
		"streaming :Observation leaves for source/series aggregation…",
	);
	const agg = await aggregateObservations(session, log, rss);
	const observationSources = agg.sources.size;
	const observationSeriesSummaries = planSeriesSummaryCount(agg);

	const base: LouvainPrecomputeResult = {
		mode: fire ? "fire" : "dry-run",
		nodes: slice.graph.order,
		edges: slice.graph.size,
		communities: count,
		singletons,
		modularity,
		summaryNodes: tier.nodes.length,
		summaryCommunityNodes: communityNodes,
		summaryBuckets: tier.nodes.length - communityNodes,
		summaryLinks: tier.links.length,
		observationSources,
		observationSeriesSummaries,
		representedObservations: agg.represented,
		observationBleedDropped: agg.bleedDropped,
		observationUnattributed: agg.unattributed,
		observationUnknownWindow: agg.unknownWindow,
		observationLinks: 0,
		observationLinksSkipped: observationSources,
		positionedNodes: slice.ids.length,
		positionsForce: positions.forceLaidOut,
		positionsPhyllotaxis: positions.phyllotaxisLaidOut,
		positionsUnpositioned: positions.unpositioned,
		positionsWarmStarted: positions.warmStarted,
		positionsWallMs: positions.wallMs,
		wallMs: Date.now() - t0,
		peakRssBytes: rss.peakBytes,
	};

	if (!fire) {
		const linkable = await probeObservationLinkable(session, [
			...agg.sources.keys(),
		]);
		log(
			"dry-run",
			"no writes — call with fire:true to persist node props + the :GraphCommunity summary tier + observation LOD",
		);
		return {
			...base,
			observationLinks: linkable,
			observationLinksSkipped: observationSources - linkable,
		};
	}

	// One timestamp for the whole run — node props, summary tier AND the
	// observation LOD share it, so a run is identifiable end-to-end (and a partial
	// write is detectable).
	const computedAt = new Date().toISOString();
	const updated = await writeCommunities(
		session,
		slice,
		communities,
		members,
		computedAt,
		positions,
		log,
	);
	log("write", `done — louvain props set on ${updated} nodes`);
	await writeSummaryTier(
		session,
		tier,
		computedAt,
		positions.summaryPositions,
		positions.overviewPositions,
		log,
	);
	log("write", "done — summary tier refreshed");
	const obsWrite = await writeObservationTiers(session, agg, computedAt, log);
	log("write", "done — observation LOD refreshed");
	const workbenchEdges = await writeWorkbenchEdgeCache(
		session,
		slice,
		computedAt,
		log,
	);
	log("write", `done — workbench edge cache (${workbenchEdges} edges)`);

	return {
		...base,
		wallMs: Date.now() - t0,
		nodesWritten: updated,
		computedAt,
		observationSources: obsWrite.sourcesWritten,
		observationSeriesSummaries: obsWrite.seriesSummariesWritten,
		observationLinks: obsWrite.linksCreated,
		observationLinksSkipped: obsWrite.linksSkipped,
	};
}

/** REMOVE all precomputed properties + the summary tier (full reversal). */
export async function rollbackLouvainPrecompute(
	session: Session,
	opts?: { log?: LouvainLog },
): Promise<{
	removedNodes: number;
	deletedSummary: number;
	deletedSeriesSummary: number;
}> {
	// Rollback is a write path too — same mutex as fire, so a rollback can
	// never interleave with an in-flight fire's delete+recreate.
	await acquirePrecomputeLock(session, "louvain-precompute-rollback");
	try {
		return await rollbackLouvainPrecomputeInner(session, opts);
	} finally {
		await releasePrecomputeLock(session);
	}
}

async function rollbackLouvainPrecomputeInner(
	session: Session,
	opts?: { log?: LouvainLog },
): Promise<{
	removedNodes: number;
	deletedSummary: number;
	deletedSeriesSummary: number;
}> {
	const log = opts?.log ?? NOOP_LOG;
	let removed = 0;
	for (;;) {
		const res = await session.run(
			// Full PUBLIC allowlist guard — same DB-boundary discipline as the write.
			// graphX in the WHERE too: positions ride the same SET as the community
			// props, but a defensive OR keeps rollback complete even against a
			// hypothetical partial state.
			`MATCH (n) WHERE (n.louvainCommunity IS NOT NULL OR n.graphX IS NOT NULL) AND (${labelPredicate("n", PUBLIC_GRAPH_PUBLIC_LABELS)})
			 WITH n LIMIT toInteger($batch)
			 REMOVE n.louvainCommunity, n.louvainCommunitySize, n.louvainComputedAt, n.graphDegree, n.graphX, n.graphY
			 RETURN count(n) AS removed`,
			{ batch: BATCH_SIZE },
		);
		const n = asNum(res.records[0]?.get("removed"));
		removed += n;
		if (n === 0) break;
		log("rollback", `${removed} nodes cleared so far`);
	}
	// :GraphCommunity DETACH DELETE also removes the Tier A observation-source
	// super-nodes (they share the label); Tier B has its own label to clear.
	const summary = await session.run(
		`MATCH (c:GraphCommunity) DETACH DELETE c RETURN count(c) AS deleted`,
	);
	const deletedSummary = asNum(summary.records[0]?.get("deleted"));
	log("rollback", `${deletedSummary} :GraphCommunity summary nodes deleted`);
	const series = await session.run(
		`MATCH (s:ObservationSeriesSummary) DETACH DELETE s RETURN count(s) AS deleted`,
	);
	const deletedSeriesSummary = asNum(series.records[0]?.get("deleted"));
	log(
		"rollback",
		`${deletedSeriesSummary} :ObservationSeriesSummary nodes deleted`,
	);
	return { removedNodes: removed, deletedSummary, deletedSeriesSummary };
}

export interface LouvainVerifyResult {
	nodesWithCommunity: number;
	distinctCommunities: number;
	writeRuns: number;
	latestRunIso: string | null;
	graphDegreeCoverage: number;
	communitySizeCoverage: number;
	/** nodes carrying BOTH graphX and graphY (#580-2 positions stage). */
	positionCoverage: number;
	summary: {
		total: number;
		communityNodes: number;
		bucketNodes: number;
		represented: number;
		links: number;
		/** summary nodes carrying a layout centroid (x/y). */
		withPosition: number;
		/** summary nodes carrying a render-scale overview position (tm #1080). */
		withOverviewPosition: number;
	};
	/** Observation LOD (tm #913) — the source super-nodes + series-summary tier. */
	observation: {
		sources: number;
		seriesSummaries: number;
		representedObservations: number;
	};
}

/** Read-only check of what a prior fire actually persisted. */
export async function verifyLouvainPrecompute(
	session: Session,
	opts?: { log?: LouvainLog },
): Promise<LouvainVerifyResult> {
	const log = opts?.log ?? NOOP_LOG;
	const res = await session.run(
		`MATCH (n) WHERE n.louvainCommunity IS NOT NULL AND (${labelPredicate("n", PUBLIC_GRAPH_PUBLIC_LABELS)})
		 RETURN count(n) AS nodes,
		        count(DISTINCT n.louvainCommunity) AS communities,
		        count(DISTINCT n.louvainComputedAt) AS runs,
		        toString(max(n.louvainComputedAt)) AS latestRun`,
	);
	const rec = res.records[0];
	const nodes = asNum(rec?.get("nodes"));
	const communities = asNum(rec?.get("communities"));
	const runs = asNum(rec?.get("runs"));
	const latestRunIso = (rec?.get("latestRun") as string | null) ?? null;
	log(
		"verify",
		`nodes-with-community=${nodes} distinct-communities=${communities} write-runs=${runs} latest=${latestRunIso ?? "—"}`,
	);
	if (runs > 1) {
		log(
			"verify",
			"WARNING: more than one louvainComputedAt stamp — a partial/older write coexists; re-fire to converge on one stamp",
		);
	}

	const props = await session.run(
		`MATCH (n) WHERE n.louvainCommunity IS NOT NULL AND (${labelPredicate("n", PUBLIC_GRAPH_PUBLIC_LABELS)})
		 RETURN sum(CASE WHEN n.graphDegree IS NOT NULL THEN 1 ELSE 0 END) AS withDegree,
		        sum(CASE WHEN n.louvainCommunitySize IS NOT NULL THEN 1 ELSE 0 END) AS withSize,
		        sum(CASE WHEN n.graphX IS NOT NULL AND n.graphY IS NOT NULL THEN 1 ELSE 0 END) AS withPosition`,
	);
	const p = props.records[0];
	const graphDegreeCoverage = asNum(p?.get("withDegree"));
	const communitySizeCoverage = asNum(p?.get("withSize"));
	const positionCoverage = asNum(p?.get("withPosition"));
	log(
		"verify",
		`graphDegree coverage=${graphDegreeCoverage} louvainCommunitySize coverage=${communitySizeCoverage} position coverage=${positionCoverage}`,
	);

	const tier = await session.run(
		`OPTIONAL MATCH (c:GraphCommunity)
		 WITH count(c) AS total,
		      sum(CASE WHEN c.kind = 'community' THEN 1 ELSE 0 END) AS communityNodes,
		      sum(CASE WHEN c.kind = 'label-bucket' THEN 1 ELSE 0 END) AS bucketNodes,
		      sum(c.size) AS represented,
		      sum(CASE WHEN c.x IS NOT NULL AND c.y IS NOT NULL THEN 1 ELSE 0 END) AS withPosition,
		      sum(CASE WHEN c.ovX IS NOT NULL AND c.ovY IS NOT NULL THEN 1 ELSE 0 END) AS withOverviewPosition
		 OPTIONAL MATCH (:GraphCommunity)-[r:GRAPH_COMMUNITY_LINK]->(:GraphCommunity)
		 RETURN total, communityNodes, bucketNodes, represented, withPosition, withOverviewPosition, count(r) AS links`,
	);
	const t = tier.records[0];
	const summary = {
		total: asNum(t?.get("total")),
		communityNodes: asNum(t?.get("communityNodes")),
		bucketNodes: asNum(t?.get("bucketNodes")),
		represented: asNum(t?.get("represented")),
		links: asNum(t?.get("links")),
		withPosition: asNum(t?.get("withPosition")),
		withOverviewPosition: asNum(t?.get("withOverviewPosition")),
	};
	log(
		"verify",
		`summary tier: total=${summary.total} communities=${summary.communityNodes} buckets=${summary.bucketNodes} represented=${summary.represented} links=${summary.links} withPosition=${summary.withPosition} withOverviewPosition=${summary.withOverviewPosition}`,
	);

	const obs = await session.run(
		`OPTIONAL MATCH (s:GraphCommunity {kind: 'observation-source'})
		 WITH count(s) AS sources, coalesce(sum(s.size), 0) AS represented
		 OPTIONAL MATCH (ss:ObservationSeriesSummary)
		 RETURN sources, represented, count(ss) AS seriesSummaries`,
	);
	const o = obs.records[0];
	const observation = {
		sources: asNum(o?.get("sources")),
		seriesSummaries: asNum(o?.get("seriesSummaries")),
		representedObservations: asNum(o?.get("represented")),
	};
	log(
		"verify",
		`observation LOD: sources=${observation.sources} seriesSummaries=${observation.seriesSummaries} represented=${observation.representedObservations}`,
	);

	return {
		nodesWithCommunity: nodes,
		distinctCommunities: communities,
		writeRuns: runs,
		latestRunIso,
		graphDegreeCoverage,
		communitySizeCoverage,
		positionCoverage,
		summary,
		observation,
	};
}

export interface LouvainStaleness {
	/** ISO of the newest louvainComputedAt stamp, or null if never fired. */
	latestRunIso: string | null;
	/** distinct louvainComputedAt stamps — >1 means a PARTIAL fire coexists
	 *  with an older one (a restart mid-write); the route treats that as stale
	 *  so the next cron reconverges instead of serving mixed output for up to
	 *  maxAgeDays (re-review finding). */
	writeRuns: number;
	/** how many nodes the last fire stamped (the coverage it achieved). */
	stampedNodeCount: number;
	/** how many structural (COMPUTE_LABELS) nodes exist right now. */
	currentStructuralCount: number;
	/** now − latestRun in ms, or null if never fired. */
	ageMs: number | null;
	/** (current − stamped) / stamped, or null if stamped is 0. */
	growthRatio: number | null;
	/** observations represented by the last fire (sum of Tier A size). This IS the
	 *  observation stamp — the derived cache persists it, parallel to how
	 *  stampedNodeCount is derived from the persisted louvain props (D9). */
	stampedObservationCount: number;
	/** live :Observation label-count-store read (O(1)). */
	currentObservationCount: number;
	/** (current − stamped) / stamped observations, or null if stamped is 0. */
	observationGrowthRatio: number | null;
}

/**
 * Cheap freshness probe for the scheduled route's staleness gate — TWO count
 * aggregations, no graph load. Lets the route no-op the expensive path when the
 * precompute is fresh AND the structural graph hasn't grown materially.
 */
export async function readLouvainStaleness(
	session: Session,
): Promise<LouvainStaleness> {
	const res = await session.run(
		`CALL {
		   MATCH (n) WHERE n.louvainCommunity IS NOT NULL AND (${labelPredicate("n", PUBLIC_GRAPH_PUBLIC_LABELS)})
		   RETURN count(n) AS stamped, toString(max(n.louvainComputedAt)) AS latest,
		          count(DISTINCT n.louvainComputedAt) AS writeRuns
		 }
		 CALL {
		   MATCH (n) WHERE ${labelPredicate("n", COMPUTE_LABELS)}
		   RETURN count(n) AS current
		 }
		 CALL {
		   MATCH (s:GraphCommunity {kind: 'observation-source'})
		   RETURN coalesce(sum(s.size), 0) AS stampedObs
		 }
		 CALL {
		   MATCH (o:Observation)
		   RETURN count(o) AS currentObs
		 }
		 RETURN stamped, latest, writeRuns, current, stampedObs, currentObs`,
	);
	const rec = res.records[0];
	const writeRuns = asNum(rec?.get("writeRuns"));
	const stampedNodeCount = asNum(rec?.get("stamped"));
	const currentStructuralCount = asNum(rec?.get("current"));
	const latestRunIso = (rec?.get("latest") as string | null) ?? null;
	const latestMs = latestRunIso ? Date.parse(latestRunIso) : Number.NaN;
	const ageMs = Number.isNaN(latestMs) ? null : Date.now() - latestMs;
	const growthRatio =
		stampedNodeCount > 0
			? (currentStructuralCount - stampedNodeCount) / stampedNodeCount
			: null;
	const stampedObservationCount = asNum(rec?.get("stampedObs"));
	const currentObservationCount = asNum(rec?.get("currentObs"));
	const observationGrowthRatio =
		stampedObservationCount > 0
			? (currentObservationCount - stampedObservationCount) /
				stampedObservationCount
			: null;
	return {
		latestRunIso,
		writeRuns,
		stampedNodeCount,
		currentStructuralCount,
		ageMs,
		growthRatio,
		stampedObservationCount,
		currentObservationCount,
		observationGrowthRatio,
	};
}
