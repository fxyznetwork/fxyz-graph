/**
 * @fxyz/graph-layout/landing-substrate — barrel.
 *
 * Data + layout primitives for building a positioned, community-colored
 * graph slice suitable for a hero/landing-style rendering surface.
 */

export { buildLandingSlice } from "./build-slice";
export { runCloseLayout2d } from "./close-layout";
export { detectCommunities } from "./community-detection";
export { runForceLayout } from "./force-layout";
export type {
	LandingCommunity,
	LandingSubstrateSlice,
	PaletteTone,
	PositionedNode,
} from "./types";
