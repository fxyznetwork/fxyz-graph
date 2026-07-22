/**
 * @fxyz/graph-engine/react — GraphPane, the one embeddable graph primitive,
 * plus its contract-tested interaction machines.
 */

export { GraphPane, type GraphPaneProps, PaneViolation } from "./GraphPane";
export { LabelOverlay, type LabelOverlayProps } from "./label-overlay";
export { LensLegend, type LensLegendProps } from "./lens-legend";
export {
	clampToWorld,
	fitWorldToMap,
	type MapProjection,
	MINIMAP_H,
	MINIMAP_W,
	Minimap,
	type MinimapProps,
	mapToWorld,
	minimapRect,
	viewportWorldRect,
	type WorldBounds,
	worldBounds,
	worldToMap,
} from "./minimap";
export {
	initialOverlayState,
	isFullPagePreset,
	type OverlayDecision,
	type OverlayEvent,
	type OverlayState,
	overlayReduce,
} from "./overlay-machine";
export {
	TapClassifier,
	type TapClassifierOptions,
	type TapOutcome,
} from "./tap-classifier";
export {
	cssScale,
	EdgeHitIndex,
	NodeHitIndex,
	type PaneView,
	panByScreenDelta,
	screenToWorld,
	worldToScreen,
	zoomAround,
} from "./view";
