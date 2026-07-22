/**
 * Types for the landing graph slice — extends `@fxyz/graph-layout` SubstrateNode
 * with force-layout positions and Louvain community assignment.
 */

import type { SubstrateData, SubstrateNode, SubstrateNodeKind } from "../types";

export type { SubstrateNode, SubstrateNodeKind } from "../types";

/** A tone slot from the palette — resolved to concrete hex on each community. */
export type PaletteTone = "amber" | "gold" | "violet" | "blue" | "green";

export interface LandingCommunity {
	id: string;
	/** Underlying node kind that anchored this community. */
	kind: SubstrateNodeKind;
	/** Optional Louvain sub-cluster id when communities are sub-partitioned. */
	louvainId?: number;
	size: number;
	tone: PaletteTone;
	/** Concrete hex for this community. */
	color: string;
	/** Strong-tier hex for text-on-light contrast. */
	strongColor: string;
}

export interface PositionedNode extends SubstrateNode {
	x: number;
	y: number;
	z: number;
	/** Resolved community id (matches LandingCommunity.id). */
	communityId: string;
	/** Palette tone derived from the community. */
	tone: PaletteTone;
	/**
	 * Deterministic 2D close-layout position `[x, y]`, rounded to 2 decimals.
	 * Seeded from this node's (x, y) and relaxed with link + collision forces
	 * server-side (`runCloseLayout2d`), so a 3D→2D crossfade descends from the
	 * same shape and proximity encodes adjacency (hub-spoke stars).
	 *
	 * PRESENT iff the node has degree ≥ 1 in the slice. Degree-0 nodes are
	 * excluded from the 2D sim, so a missing `close2d` is the unambiguous
	 * "isolated" signal.
	 */
	close2d?: [number, number];
}

export interface LandingSubstrateSlice extends Omit<SubstrateData, "nodes"> {
	nodes: PositionedNode[];
	communities: LandingCommunity[];
	/** Map nodeId → communityId for quick lookups in the renderer. */
	nodeCommunity: Record<string, string>;
}
