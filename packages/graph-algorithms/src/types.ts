/**
 * The first-class algorithm contract.
 *
 * Every analytic — FX routing, arbitrage cycle-detection, eigenvector
 * centrality, PageRank, Louvain, DebtRank, MeritRank, CES synthesis, decay — is
 * the SAME shape: `run(workingSet, params) => Promise<AlgoResult>`, plus a
 * declared `family`, the `venues` it can execute in, and a default visual
 * encoding channel. FX algorithms and graph algorithms are siblings here,
 * distinguished by `family`, never by "is it blocked." A missing server
 * capability (e.g. a graph-database plugin not being installed) conflates
 * "unavailable right now" with "impossible" — under this contract, where an
 * algorithm runs is a per-call `Venue` decision, not a capability gate — see
 * venue.ts.
 *
 * This module is intentionally dependency-light (no database client, no
 * react, no three) so the SAME contract is importable by both a server
 * resolver and a client engine. The `Promise` return is the load-bearing
 * trick: it makes client-vs-server an implementation detail rather than an
 * interface decision.
 */

export type NodeId = string;
export type CommunityId = number | string;

/** A node in a working set. `properties` carries arbitrary graph data. */
export interface GraphNode {
	id: NodeId;
	labels?: string[];
	properties?: Record<string, unknown>;
}

/**
 * A directed edge in a working set. `weight` is the additive cost used by
 * pathfinding/cycle algorithms (e.g. -ln(rate) for FX). When absent, an
 * algorithm may derive it from `properties` (e.g. `properties.rate`).
 */
export interface GraphEdge {
	id?: string;
	source: NodeId;
	target: NodeId;
	weight?: number;
	type?: string;
	properties?: Record<string, unknown>;
}

/**
 * The loaded working set an algorithm runs over. This is the unit GraphXR /
 * Ogma / Cambridge-Intelligence all compute on — the subgraph currently in
 * scope, not the whole database. Whole-graph venues (cron/GDS) materialize a
 * working set the same shape.
 */
export interface SubGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/** An ordered path through the working set (pathfinding result). */
export interface AlgoPath {
	nodes: NodeId[];
	edges: GraphEdge[];
	/** Sum of edge weights along the path. */
	totalWeight?: number;
	/** Optional domain meta (e.g. compounded FX rate, hop count). */
	meta?: Record<string, unknown>;
}

/** A closed cycle through the working set (e.g. an arbitrage opportunity). */
export interface AlgoCycle {
	nodes: NodeId[];
	edges: GraphEdge[];
	/** Optional domain meta (e.g. net profit %, as-of timestamp). */
	meta?: Record<string, unknown>;
}

export type ResultKind =
	| "scores"
	| "communities"
	| "paths"
	| "cycles"
	| "derived";

/**
 * The closed union every algorithm returns. The renderer never sees the
 * algorithm — it sees the result, and the Encoding Bridge (a separate layer)
 * maps `kind` to a visual-grammar channel. This is the GraphXR/Ogma
 * "algorithm writes a value, the encoder reads it" contract.
 */
export type AlgoResult =
	/** centrality, synthesis, λ2 — a per-node scalar. */
	| { kind: "scores"; values: Map<NodeId, number> }
	/** Louvain / connected-components — a per-node community label. */
	| { kind: "communities"; values: Map<NodeId, CommunityId> }
	/** Bellman-Ford routing — one or more ordered paths. */
	| { kind: "paths"; paths: AlgoPath[] }
	/** Arbitrage — negative cycles. */
	| { kind: "cycles"; cycles: AlgoCycle[] }
	/** Anything richer than a scalar — a per-node property bag. */
	| { kind: "derived"; values: Map<NodeId, Record<string, unknown>> };

export type AlgorithmFamily =
	| "centrality"
	| "community"
	| "pathfinding"
	| "fx-routing"
	| "cycle"
	| "synthesis"
	| "temporal";

/**
 * Where an algorithm executes. This is a DERIVED field chosen per-call by the
 * venue resolver from the measured working-set size — not a global switch and
 * never a "blocked" state.
 *
 * - `client-ts`        : pure TS over the in-browser working set (how eigenvector
 *                        + DebtRank centrality can run entirely client-side).
 * - `server-cypher`    : a Neo4j Cypher implementation (how Bellman-Ford routing
 *                        can run server-side over a live graph).
 * - `precomputed-cron` : heavy whole-graph metrics materialized nightly onto
 *                        node properties (the repurposed memgraph-sync slot).
 * - `server-gds`       : Neo4j Graph Data Science procedures. Declared-but-only-
 *                        selected once the GDS plugin is installed; enabling it
 *                        is config + one availability flag, zero interface change.
 */
export type Venue =
	| "client-ts"
	| "server-cypher"
	| "precomputed-cron"
	| "server-gds";

/**
 * How an AlgoResult binds to the visual grammar. Channels map by result kind:
 * scores → size/brightness, communities → categorical colour, paths →
 * foreground, cycles → edge-pulse. (Consumed by the Encoding Bridge layer.)
 */
export type EncodingChannel =
	| "size"
	| "brightness"
	| "color-categorical"
	| "foreground"
	| "edge-pulse"
	| "none";

/** A single parameter descriptor — enough to render a generic param form. */
export interface ParamDescriptor {
	kind: "number" | "string" | "boolean" | "nodeId" | "enum";
	label?: string;
	description?: string;
	default?: unknown;
	required?: boolean;
	min?: number;
	max?: number;
	options?: ReadonlyArray<string | number>;
}

/** A param schema is a descriptor per param key. */
export type ParamSchema<P> = { [K in keyof P]-?: ParamDescriptor };

/**
 * One registry row. The whole point of the architecture: adding an analytic is
 * adding a row, not building a pipeline.
 */
export interface Algorithm<P = Record<string, never>> {
	id: string;
	family: AlgorithmFamily;
	title?: string;
	description?: string;
	/** Param schema (drives the generic workbench form). */
	paramSchema: ParamSchema<P>;
	/** Venues this algorithm CAN run in (the resolver picks the actual one). */
	venues: readonly Venue[];
	/** Per-venue working-set size envelope. Out-of-envelope selection is refused. */
	maxWorkingSet?: Partial<Record<Venue, number>>;
	/** Default channel the Encoding Bridge uses unless a preset overrides it. */
	defaultEncodingChannel: EncodingChannel;
	/** The result kind this algorithm always returns (matches `run`). */
	resultKind: ResultKind;
	/**
	 * REQUIRED for ƒxyz-coined metrics (e.g. R0, circle temperature). The
	 * registry refuses to register a coinage whose :Concept is not active
	 * (operator-hud-grounding enforced at registration time). Published
	 * algorithms (PageRank, Louvain, Bellman-Ford, …) leave this undefined.
	 */
	groundingConceptId?: string;
	/** The computation. `Promise` makes venue an implementation detail. */
	run: (workingSet: SubGraph, params: P) => Promise<AlgoResult>;
}
