/**
 * The renderer backend contract.
 *
 * A graph-visualization library's observable API surface abstracted into a
 * seam, so a renderer swap (sigma / cosmos / a custom canvas) is a backend
 * change, never another integration rewrite. Contract tests run against THIS
 * interface, not against any specific renderer; the stub backend keeps the
 * seam honest.
 */

export interface BackendNode {
	id: string;
	x?: number;
	y?: number;
	[key: string]: unknown;
}

export interface BackendRel {
	id: string;
	from: string;
	to: string;
	[key: string]: unknown;
}

export interface BackendConstructOptions {
	/** HTMLElement in real backends; unknown keeps the core DOM-free. */
	container: unknown;
	renderer: "canvas" | "webgl";
	/**
	 * Default is `free` + server positions; client sims are an explicit
	 * small-graph opt-in via the layout policy.
	 */
	layout: "free" | "d3Force" | "forceDirected";
	/**
	 * Literal `true` — telemetry is disabled at every backend construction
	 * site, at the TYPE level.
	 */
	disableTelemetry: true;
	/** Optional renderer levers. */
	minZoom?: number;
	maxZoom?: number;
	layoutTimeLimit?: number;
	relationshipThreshold?: number;
}

export interface GraphBackend {
	readonly name: string;
	getNodes(): BackendNode[];
	getRelationships(): BackendRel[];
	getNodeById(id: string): BackendNode | undefined;
	getNodePositions(): Record<string, { x: number; y: number }>;
	/** The physics-off path: id-keyed positions, honored under `free`. */
	setNodePositions(
		positions: Array<{ id: string; x: number; y: number }>,
		animate?: boolean,
	): void;
	/** Incremental upsert — there is NO setData; reconstruction is forbidden. */
	addAndUpdateElementsInGraph(nodes: BackendNode[], rels: BackendRel[]): void;
	/**
	 * Pin ops (member drag). Under `free` layout setNodePositions is already
	 * authoritative; the pin flag matters under sim layouts, where an unpinned
	 * node gets yanked back by the force pass. Optional: a backend without a sim
	 * concept may omit them.
	 */
	pinNode?(id: string): void;
	unPinNode?(id: string): void;
	removeNodesWithIds(ids: string[]): void;
	removeRelationshipsWithIds(ids: string[]): void;
	getSelectedNodeIds(): string[];
	setSelectedNodeIds(ids: string[]): void;
	/**
	 * Incident-edge half of the ONE highlight: the engine pushes the selected
	 * node's incident edge ids so the neighborhood lights with the ring. Same
	 * delta semantics as setSelectedNodeIds.
	 */
	setSelectedRelIds(ids: string[]): void;
	deselectAll(): void;
	setZoomAndPan(zoom: number, panX: number, panY: number): void;
	getScale(): number;
	getPan(): { x: number; y: number };
	fit(nodeIds?: string[], animated?: boolean): void;
	/** Live renderer switch (canvas ↔ webgl) without reconstruction. */
	setRenderer(renderer: "canvas" | "webgl"): void;
	isLayoutMoving(): boolean;
	destroy(): void;
}

export type BackendFactory = (options: BackendConstructOptions) => GraphBackend;

export class BackendViolation extends Error {
	readonly rule: string;
	constructor(rule: string, message: string) {
		super(`[${rule}] ${message}`);
		this.name = "BackendViolation";
		this.rule = rule;
	}
}

/**
 * Runtime guard shared by every backend implementation: refuse construction
 * with telemetry on (defense in depth behind the literal type).
 */
export function assertTelemetryDisabled(
	options: BackendConstructOptions,
): void {
	if ((options as { disableTelemetry: boolean }).disableTelemetry !== true) {
		throw new BackendViolation(
			"telemetry",
			"backend constructed without disableTelemetry:true",
		);
	}
}
