/**
 * In-memory backend — the contract-test double that keeps the renderer seam
 * honest (engine law 12). Also records an op log so laws 8/14 can assert
 * incremental behavior (diff ops, never reconstruction).
 */

import {
	assertTelemetryDisabled,
	type BackendConstructOptions,
	type BackendFactory,
	type BackendNode,
	type BackendRel,
	type GraphBackend,
} from "./contract";

export interface StubOp {
	op:
		| "construct"
		| "addAndUpdate"
		| "removeNodes"
		| "removeRels"
		| "setPositions"
		| "pinNode"
		| "unPinNode"
		| "fit"
		| "setRenderer"
		| "destroy";
	detail?: unknown;
}

export class StubBackend implements GraphBackend {
	readonly name = "stub";
	readonly ops: StubOp[] = [];
	private nodes = new Map<string, BackendNode>();
	private rels = new Map<string, BackendRel>();
	private selected = new Set<string>();
	private selectedRels = new Set<string>();
	private pinned = new Set<string>();
	private scale = 1;
	private pan = { x: 0, y: 0 };
	private renderer: "canvas" | "webgl";

	constructor(options: BackendConstructOptions) {
		assertTelemetryDisabled(options);
		this.renderer = options.renderer;
		this.ops.push({ op: "construct", detail: { renderer: options.renderer } });
	}

	getNodes(): BackendNode[] {
		return [...this.nodes.values()];
	}
	getRelationships(): BackendRel[] {
		return [...this.rels.values()];
	}
	getNodeById(id: string): BackendNode | undefined {
		return this.nodes.get(id);
	}
	getNodePositions(): Record<string, { x: number; y: number }> {
		const out: Record<string, { x: number; y: number }> = {};
		for (const [id, n] of this.nodes) {
			if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
				out[id] = { x: n.x as number, y: n.y as number };
			}
		}
		return out;
	}
	setNodePositions(
		positions: Array<{ id: string; x: number; y: number }>,
	): void {
		this.ops.push({ op: "setPositions", detail: positions.length });
		for (const p of positions) {
			const node = this.nodes.get(String(p.id));
			if (node) {
				node.x = p.x;
				node.y = p.y;
			}
		}
	}
	addAndUpdateElementsInGraph(nodes: BackendNode[], rels: BackendRel[]): void {
		this.ops.push({
			op: "addAndUpdate",
			detail: { nodes: nodes.length, rels: rels.length },
		});
		for (const n of nodes) {
			this.nodes.set(String(n.id), { ...this.nodes.get(String(n.id)), ...n });
		}
		for (const r of rels) {
			this.rels.set(String(r.id), { ...this.rels.get(String(r.id)), ...r });
		}
	}
	removeNodesWithIds(ids: string[]): void {
		this.ops.push({ op: "removeNodes", detail: ids.length });
		for (const id of ids) {
			this.nodes.delete(String(id));
			this.selected.delete(String(id));
		}
	}
	removeRelationshipsWithIds(ids: string[]): void {
		this.ops.push({ op: "removeRels", detail: ids.length });
		for (const id of ids) this.rels.delete(String(id));
	}
	pinNode(id: string): void {
		this.ops.push({ op: "pinNode", detail: id });
		this.pinned.add(String(id));
	}
	unPinNode(id: string): void {
		this.ops.push({ op: "unPinNode", detail: id });
		this.pinned.delete(String(id));
	}
	/** Test helper: currently-pinned ids (tm #1120 law assertions). */
	pinnedIds(): string[] {
		return [...this.pinned];
	}
	getSelectedNodeIds(): string[] {
		return [...this.selected];
	}
	setSelectedNodeIds(ids: string[]): void {
		this.selected = new Set(ids.map(String));
	}
	setSelectedRelIds(ids: string[]): void {
		this.selectedRels = new Set(ids.map(String));
	}
	getSelectedRelIds(): string[] {
		return [...this.selectedRels];
	}
	deselectAll(): void {
		this.selected.clear();
		this.selectedRels.clear();
	}
	setZoomAndPan(zoom: number, panX: number, panY: number): void {
		this.scale = zoom;
		this.pan = { x: panX, y: panY };
	}
	getScale(): number {
		return this.scale;
	}
	getPan(): { x: number; y: number } {
		return { ...this.pan };
	}
	fit(nodeIds?: string[], animated?: boolean): void {
		this.ops.push({ op: "fit", detail: { count: nodeIds?.length, animated } });
	}
	setRenderer(renderer: "canvas" | "webgl"): void {
		this.ops.push({ op: "setRenderer", detail: renderer });
		this.renderer = renderer;
	}
	getRenderer(): "canvas" | "webgl" {
		return this.renderer;
	}
	isLayoutMoving(): boolean {
		return false; // free layout: settle is known at load
	}
	destroy(): void {
		this.ops.push({ op: "destroy" });
		this.nodes.clear();
		this.rels.clear();
		this.selected.clear();
	}
	/** Test helper: constructions observed via the op log. */
	countOps(op: StubOp["op"]): number {
		return this.ops.filter((o) => o.op === op).length;
	}
}

export const createStubBackend: BackendFactory = (options) =>
	new StubBackend(options);
