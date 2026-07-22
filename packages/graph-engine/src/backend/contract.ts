/**
 * The renderer backend contract (DESIGN-V2 §3; NVL-UNDERUSE-AUDIT §5).
 *
 * This is NVL's observable API surface abstracted into a seam, so a renderer
 * swap (sigma / cosmos / custom — the P4 founder gate) is a backend change,
 * never another integration rewrite (engine law 12). Contract tests run
 * against THIS interface, not against `@neo4j-nvl` imports; backend-stub
 * keeps the seam honest.
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
	 * Default is `free` + server positions (engine law 5 / audit RC1); client
	 * sims are an explicit small-graph opt-in via the layout policy.
	 */
	layout: "free" | "d3Force" | "forceDirected";
	/**
	 * Literal `true` — telemetry is disabled at every backend construction
	 * site, at the TYPE level (engine law 7).
	 */
	disableTelemetry: true;
	/** Real engine levers the 2024 adapter never set (audit RC6). */
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
	/** Incremental upsert — there is NO setData; law 8 forbids reconstruction. */
	addAndUpdateElementsInGraph(nodes: BackendNode[], rels: BackendRel[]): void;
	/**
	 * Pin ops (tm #1120 — member drag). Under `free` layout setNodePositions is
	 * already authoritative; the pin flag matters under sim layouts, where an
	 * unpinned node gets yanked back by the force pass. Optional: a backend
	 * without a sim concept may omit them (NVL 1.2.0 has both — verified in
	 * the bundle: pinNode → nodes.update([{id, pinned:true}])).
	 */
	pinNode?(id: string): void;
	unPinNode?(id: string): void;
	removeNodesWithIds(ids: string[]): void;
	removeRelationshipsWithIds(ids: string[]): void;
	getSelectedNodeIds(): string[];
	setSelectedNodeIds(ids: string[]): void;
	/**
	 * Incident-edge half of the ONE lawful highlight (law 13, #1081): the
	 * engine pushes the selected node's incident edge ids so the neighborhood
	 * lights with the ring. Same delta semantics as setSelectedNodeIds.
	 */
	setSelectedRelIds(ids: string[]): void;
	deselectAll(): void;
	setZoomAndPan(zoom: number, panX: number, panY: number): void;
	getScale(): number;
	getPan(): { x: number; y: number };
	fit(nodeIds?: string[], animated?: boolean): void;
	/** LIVE on NVL 1.2.0 (fair-run addendum A5 — the #791 no-op is stale). */
	setRenderer(renderer: "canvas" | "webgl"): void;
	isLayoutMoving(): boolean;
	destroy(): void;
}

export type BackendFactory = (options: BackendConstructOptions) => GraphBackend;

export class BackendViolation extends Error {
	readonly law: string;
	constructor(law: string, message: string) {
		super(`[${law}] ${message}`);
		this.name = "BackendViolation";
		this.law = law;
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
			"law-7",
			"backend constructed without disableTelemetry:true",
		);
	}
}
