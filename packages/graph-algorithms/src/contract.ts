/**
 * The Encoding Bridge — the `./contract` entry point.
 *
 * The renderer never sees an algorithm; it sees an `AlgoResult` and an
 * `EncodingChannel`. This module is the pure mapping between them: it turns a
 * result (`scores` / `communities` / `paths` / `cycles` / `derived`) into
 * concrete per-node visual instructions plus path/cycle highlights. The
 * algorithm writes a value; the encoder reads it — which makes "color/size by
 * meaning" real without the renderer knowing a single algorithm name.
 *
 * It is shipped as a SEPARATE bundle entry (`@fxyz/graph-algorithms/contract`)
 * so the visualization layer can import the encoding types WITHOUT pulling the
 * algorithm implementations. Pure; no rendering or database dependency.
 */

import type {
	AlgoCycle,
	AlgoPath,
	AlgoResult,
	CommunityId,
	EncodingChannel,
	NodeId,
} from "./types";

export type { AlgoResult, EncodingChannel, NodeId } from "./types";

/** A per-node visual instruction. All channels optional; the renderer applies what is set. */
export interface NodeVisual {
	/** ∈ [0,1] — relative node size. */
	size?: number;
	/** ∈ [0,1] — relative brightness / opacity. */
	brightness?: number;
	/** Categorical community bucket; the renderer maps it to a palette slot. */
	communityId?: CommunityId;
	/** The raw scalar before normalization (tooltips / telemetry). */
	rawValue?: number;
}

/** The fully-encoded result, ready for a renderer to apply. */
export interface VisualEncoding {
	channel: EncodingChannel;
	nodes: Map<NodeId, NodeVisual>;
	/** Paths to foreground (e.g. the cheapest FX route). */
	foregroundPaths: AlgoPath[];
	/** Cycles to pulse (e.g. an arbitrage loop). */
	pulseCycles: AlgoCycle[];
}

export interface EncodeOptions {
	/** Override the channel that the result kind would default to. */
	channel?: EncodingChannel;
}

/**
 * Map an `AlgoResult` onto visual channels. Pure and total over the result
 * union — adding a new result kind is a compile error here until it is encoded.
 */
export function encodeResult(
	result: AlgoResult,
	options: EncodeOptions = {},
): VisualEncoding {
	const nodes = new Map<NodeId, NodeVisual>();
	const channel = options.channel ?? defaultChannelFor(result.kind);
	const encoding: VisualEncoding = {
		channel,
		nodes,
		foregroundPaths: [],
		pulseCycles: [],
	};

	switch (result.kind) {
		case "scores": {
			const norm = normalize(result.values);
			for (const [id, value] of result.values) {
				const n = norm.get(id) ?? 0;
				nodes.set(
					id,
					channel === "size"
						? { size: n, rawValue: value }
						: { brightness: n, rawValue: value },
				);
			}
			break;
		}
		case "communities": {
			for (const [id, communityId] of result.values) {
				nodes.set(id, { communityId });
			}
			break;
		}
		case "paths": {
			encoding.foregroundPaths = result.paths;
			break;
		}
		case "cycles": {
			encoding.pulseCycles = result.cycles;
			break;
		}
		case "derived": {
			for (const [id, bag] of result.values) {
				const raw = typeof bag.value === "number" ? bag.value : undefined;
				nodes.set(id, { rawValue: raw });
			}
			break;
		}
	}

	return encoding;
}

/** The channel a given result kind binds to unless a preset overrides it. */
export function defaultChannelFor(kind: AlgoResult["kind"]): EncodingChannel {
	switch (kind) {
		case "scores":
			return "brightness";
		case "communities":
			return "color-categorical";
		case "paths":
			return "foreground";
		case "cycles":
			return "edge-pulse";
		default:
			return "none";
	}
}

/**
 * Min-max normalize a scalar map to [0,1]. A degenerate all-equal map collapses
 * to all-1 (if positive) or all-0 — never NaN.
 */
export function normalize(values: Map<NodeId, number>): Map<NodeId, number> {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const v of values.values()) {
		if (v < min) min = v;
		if (v > max) max = v;
	}
	const span = max - min;
	const out = new Map<NodeId, number>();
	for (const [id, v] of values) {
		out.set(id, span > 0 ? (v - min) / span : max > 0 ? 1 : 0);
	}
	return out;
}
