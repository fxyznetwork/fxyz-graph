/**
 * Landing-substrate types — extends `@fxyz/graph-layout` SubstrateNode
 * with force-layout positions and Louvain community assignment.
 */

import type { SubstrateData, SubstrateNode, SubstrateNodeKind } from "../types";

export type { SubstrateNode, SubstrateNodeKind } from "../types";

/** Color assignment from the Stellar palette (`packages/design-system/lib/brand-colors.ts`). */
export type StellarTone = "florin" | "joule" | "wisdom" | "network" | "earth";

export interface LandingCommunity {
	id: string;
	/** Underlying node kind that anchored this community. */
	kind: SubstrateNodeKind;
	/** Optional Louvain sub-cluster id when communities are sub-partitioned. */
	louvainId?: number;
	size: number;
	tone: StellarTone;
	/** OKLCH-tuned hex from Brand Codex v3.0 (`brand-colors.ts`). */
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
	/** Stellar tone derived from the community. */
	tone: StellarTone;
	/**
	 * Deterministic 2D close-layout position `[x, y]`, rounded to 2 decimals
	 * (Wave C — close-v2.md §5 req 3 + 9). Seeded from this node's substrate
	 * (x, y) and relaxed with link + collision forces server-side
	 * (`runCloseLayout2d`), so the 3D→2D crossfade descends from the same
	 * shape and proximity encodes adjacency (hub-spoke ego stars).
	 *
	 * PRESENT iff the node has degree ≥ 1 in the slice. Degree-0 dust is
	 * excluded from the 2D sim — the close consumer dust-drops it anyway
	 * (#106); a missing `close2d` IS the unambiguous dust signal.
	 */
	close2d?: [number, number];
}

export interface LandingSubstrateSlice extends Omit<SubstrateData, "nodes"> {
	nodes: PositionedNode[];
	communities: LandingCommunity[];
	/** Map nodeId → communityId for quick lookups in the renderer. */
	nodeCommunity: Record<string, string>;
}
