/**
 * @fxyz/graph-engine — headless graph controller.
 * Invariants before features; renderers are swappable backends; node identity
 * comes from @fxyz/graph-contract.
 */

export {
	assertTelemetryDisabled,
	type BackendConstructOptions,
	type BackendFactory,
	type BackendNode,
	type BackendRel,
	BackendViolation,
	type GraphBackend,
} from "./backend/contract";
export {
	createNvlBackendFactory,
	NvlBackend,
	type NvlInstanceFactory,
	type NvlLikeCallbacks,
	type NvlLikeInstance,
} from "./backend/nvl";
export { createStubBackend, StubBackend, type StubOp } from "./backend/stub";
export { applyDataUpdate, computeElementDiff } from "./core/diff";
export {
	type EngineDeps,
	type EnginePhase,
	EngineViolation,
	GraphEngine,
} from "./core/engine";
export { PositionStore, SelectionStore } from "./identity/stores";
export {
	type IndexedPoint,
	SpatialGrid,
	throttle,
} from "./interaction/hit-index";
export { pickLabeledNodes } from "./labels/budget";
export {
	DEFAULT_LAYOUT_POLICY,
	type LayoutPolicy,
	LayoutPolicyViolation,
	resolveLayout,
} from "./layout/policy";
export {
	applyStyleRules,
	COMMUNITY_PALETTE,
	communityColor,
	diffStylePatches,
	provenanceVisual,
	sizeFromValue,
	type StylePatch,
} from "./lens/apply";
