/**
 * Train 2026-07-18 — two engine-layer affordances, locked as tests:
 *
 *  1. #1081 incident-edge emphasis: selecting a node lights its incident
 *     edges through the SAME lawful highlight channel (law 13) — the engine
 *     derives the edge set from payload adjacency and pushes rel `selected`
 *     deltas; nothing hovers, nothing pulses.
 *  2. Deterministic dpr-honest fit: server-positioned payloads fit through
 *     the verified transform model (css = (zoom/dpr)·(world − pan) + c/2)
 *     instead of the vendor fit, which under-zoomed ~2× on dpr-2 displays
 *     (prod walk 2026-07-18: the #1080 cloud filled ~40% of the viewport).
 */

import {
	type BuildPayloadInput,
	buildPayload,
	type GraphEdgeV1,
	type GraphNodeV1,
	type GraphPayloadV1,
	makeEdgeId,
	makeRef,
} from "@fxyz/graph-contract";
import type { BackendConstructOptions } from "../backend/contract";
import { NvlBackend, type NvlLikeInstance } from "../backend/nvl";
import { StubBackend } from "../backend/stub";
import { GraphEngine } from "../core/engine";

const OPTS: BackendConstructOptions = {
	container: null,
	renderer: "webgl",
	layout: "free",
	disableTelemetry: true,
};

function node(key: string, x = 0, y = 0): GraphNodeV1 {
	return {
		id: makeRef("currency", key),
		kind: "currency",
		label: key,
		measures: { degree: 1 },
		x,
		y,
		provenance: "real",
	};
}

function edge(type: string, a: GraphNodeV1, b: GraphNodeV1): GraphEdgeV1 {
	return {
		id: makeEdgeId(type, a.id, b.id),
		source: a.id,
		target: b.id,
		type,
		provenance: "real",
	};
}

function payload(
	nodes: GraphNodeV1[],
	edges: GraphEdgeV1[] = [],
	overrides: Partial<BuildPayloadInput> = {},
): GraphPayloadV1 {
	return buildPayload({
		audience: "member",
		tier: "panel",
		lens: "test",
		scope: "test",
		dataVersion: "dv1",
		aclVersion: "acl1",
		nodes,
		edges,
		coverage: { framing: "curated" },
		sampled: false,
		positionsIncluded: true,
		...overrides,
	});
}

function makeEngine(container: unknown = null) {
	let stub: StubBackend | undefined;
	const engine = new GraphEngine(
		(o) => {
			stub = new StubBackend(o);
			return stub;
		},
		{ ...OPTS, container },
	);
	if (!stub) throw new Error("factory not called");
	return { engine, stub };
}

// ── #1081 incident-edge emphasis ────────────────────────────────────────────

describe("#1081 · selection lights the incident edges (law 13)", () => {
	const a = node("USD", 0, 0);
	const b = node("EUR", 10, 0);
	const c = node("JPY", 0, 10);
	const ab = edge("CORRELATED", a, b);
	const ac = edge("CORRELATED", a, c);
	const bc = edge("CORRELATED", b, c);

	it("select(node) pushes that node's incident edge ids", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([a, b, c], [ab, ac, bc]));
		engine.select([a.id]);
		expect(new Set(stub.getSelectedRelIds())).toEqual(new Set([ab.id, ac.id]));
	});

	it("reselect swaps the lit neighborhood; empty select clears it", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([a, b, c], [ab, ac, bc]));
		engine.select([a.id]);
		engine.select([b.id]);
		expect(new Set(stub.getSelectedRelIds())).toEqual(new Set([ab.id, bc.id]));
		engine.select([]);
		expect(stub.getSelectedRelIds()).toEqual([]);
	});

	it("multi-ref selection (path emphasis) unions incident edges", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([a, b, c], [ab, ac, bc]));
		engine.select([a.id, b.id]);
		expect(new Set(stub.getSelectedRelIds())).toEqual(
			new Set([ab.id, ac.id, bc.id]),
		);
	});

	it("adjacency follows the latest ingest (stale edges never light)", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([a, b, c], [ab, ac, bc]));
		engine.ingest(payload([a, b], [ab]));
		engine.select([a.id]);
		expect(stub.getSelectedRelIds()).toEqual([ab.id]);
	});
});

describe("#1081 · NvlBackend pushes rel selected deltas (flips only)", () => {
	function makeFakeNvl() {
		const relPatches: Array<Record<string, unknown>> = [];
		const instance: NvlLikeInstance = {
			getNodes: () => [],
			getRelationships: () => [],
			setNodePositions: () => {},
			addAndUpdateElementsInGraph: (_ns = [], rs = []) => {
				for (const r of rs as Array<Record<string, unknown>>) {
					relPatches.push(r);
				}
			},
			removeNodesWithIds: () => {},
			removeRelationshipsWithIds: () => {},
			setZoomAndPan: () => {},
			getScale: () => 1,
			getPan: () => ({ x: 0, y: 0 }),
			fit: () => {},
			setRenderer: () => {},
			destroy: () => {},
		};
		return { instance, relPatches };
	}

	it("pushes selected:true, then only the delta on change", () => {
		const { instance, relPatches } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		backend.setSelectedRelIds(["e1", "e2"]);
		expect(new Set(relPatches.map((p) => `${p.id}:${p.selected}`))).toEqual(
			new Set(["e1:true", "e2:true"]),
		);
		relPatches.length = 0;
		backend.setSelectedRelIds(["e2", "e3"]);
		expect(new Set(relPatches.map((p) => `${p.id}:${p.selected}`))).toEqual(
			new Set(["e1:false", "e3:true"]),
		);
	});

	it("deselectAll clears rel flags in the renderer", () => {
		const { instance, relPatches } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		backend.setSelectedRelIds(["e1"]);
		relPatches.length = 0;
		backend.deselectAll();
		expect(relPatches).toEqual([{ id: "e1", selected: false }]);
	});
});

// ── #1097 selected-edge salience (NvlBackend) ────────────────────────────────

describe("#1097 · selected edges are salient, restored to subdued on deselect", () => {
	function makeFakeNvl() {
		const relPatches: Array<Record<string, unknown>> = [];
		const instance: NvlLikeInstance = {
			getNodes: () => [],
			getRelationships: () => [],
			setNodePositions: () => {},
			addAndUpdateElementsInGraph: (_ns = [], rs = []) => {
				for (const r of rs as Array<Record<string, unknown>>) relPatches.push(r);
			},
			removeNodesWithIds: () => {},
			removeRelationshipsWithIds: () => {},
			setZoomAndPan: () => {},
			getScale: () => 1,
			getPan: () => ({ x: 0, y: 0 }),
			fit: () => {},
			setRenderer: () => {},
			destroy: () => {},
		};
		return { instance, relPatches };
	}

	// A subdued base edge, ingested through the public path so the backend
	// snapshots it (mirrors engine.ingest's edge styling).
	function seedBase(
		backend: NvlBackend,
		relPatches: Array<Record<string, unknown>>,
		id = "e1",
		width = 1,
	) {
		backend.addAndUpdateElementsInGraph(
			[],
			[{ id, from: "a", to: "b", color: "rgba(148, 163, 184, 0.35)", width }],
		);
		relPatches.length = 0;
	}

	it("the flip-to-selected carries an explicit salient colour + boosted width", () => {
		const { instance, relPatches } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		seedBase(backend, relPatches, "e1", 1);
		backend.setSelectedRelIds(["e1"]);
		expect(relPatches).toHaveLength(1);
		const p = relPatches[0];
		expect(p.selected).toBe(true);
		// bright, opaque — plainly distinct from the subdued 0.35-alpha base.
		expect(p.color).toBe("rgba(174, 194, 248, 0.95)");
		// clearly wider than the subdued base width (NVL further ×1.5's it).
		expect(p.width).toBe(2.5);
		expect(p.width as number).toBeGreaterThan(1);
	});

	it("the flip-to-deselected restores the exact subdued base style", () => {
		const { instance, relPatches } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		seedBase(backend, relPatches, "e1", 0.8);
		backend.setSelectedRelIds(["e1"]);
		relPatches.length = 0;
		backend.setSelectedRelIds([]);
		expect(relPatches).toEqual([
			{
				id: "e1",
				selected: false,
				color: "rgba(148, 163, 184, 0.35)",
				width: 0.8,
			},
		]);
	});

	it("deselectAll restores the subdued base style too", () => {
		const { instance, relPatches } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		seedBase(backend, relPatches, "e1", 1.4);
		backend.setSelectedRelIds(["e1"]);
		relPatches.length = 0;
		backend.deselectAll();
		expect(relPatches).toEqual([
			{
				id: "e1",
				selected: false,
				color: "rgba(148, 163, 184, 0.35)",
				width: 1.4,
			},
		]);
	});

	it("a selection-only rel (no base snapshot) restores to just the flag", () => {
		const { instance, relPatches } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		backend.setSelectedRelIds(["e9"]);
		relPatches.length = 0;
		backend.setSelectedRelIds([]);
		expect(relPatches).toEqual([{ id: "e9", selected: false }]);
	});
});

// ── #1097 explicit edge-set selection (engine.selectEdges) ───────────────────

describe("#1097 · engine.selectEdges — explicit edge-set salience", () => {
	const a = node("USD", 0, 0);
	const b = node("EUR", 10, 0);
	const c = node("JPY", 0, 10);
	const ab = edge("CORRELATED", a, b);
	const ac = edge("CORRELATED", a, c);
	const bc = edge("CORRELATED", b, c);

	it("lights EXACTLY the given edge ids, leaving node selection untouched", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([a, b, c], [ab, ac, bc]));
		engine.selectEdges([ab.id, bc.id]);
		expect(new Set(stub.getSelectedRelIds())).toEqual(new Set([ab.id, bc.id]));
		expect(stub.getSelectedNodeIds()).toEqual([]);
	});

	it("a subsequent selectEdges replaces the previous explicit set", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([a, b, c], [ab, ac, bc]));
		engine.selectEdges([ab.id]);
		engine.selectEdges([ac.id]);
		expect(stub.getSelectedRelIds()).toEqual([ac.id]);
	});

	it("deselectAll clears node AND edge highlights", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([a, b, c], [ab, ac, bc]));
		engine.select([a.id]); // node + incident edges
		engine.deselectAll();
		expect(stub.getSelectedRelIds()).toEqual([]);
		expect(stub.getSelectedNodeIds()).toEqual([]);
	});
});

// ── deterministic dpr-honest fit ────────────────────────────────────────────

describe("deterministic fit · server positions fill the measured container", () => {
	const globalWithDpr = globalThis as { devicePixelRatio?: number };
	let savedDpr: number | undefined;
	beforeEach(() => {
		savedDpr = globalWithDpr.devicePixelRatio;
	});
	afterEach(() => {
		if (savedDpr === undefined) delete globalWithDpr.devicePixelRatio;
		else globalWithDpr.devicePixelRatio = savedDpr;
	});

	const spread = [
		node("A", -300, -300),
		node("B", 300, 300),
		node("C", 0, 0),
	];

	it("computes zoom = cssScale·dpr and pans to the bbox center", () => {
		globalWithDpr.devicePixelRatio = 2;
		const container = { clientWidth: 800, clientHeight: 656 };
		const { engine, stub } = makeEngine(container);
		engine.ingest(payload(spread));
		// extent 600×600; avail = (800−112)×(656−112) → cssScale = 544/600
		const cssScale = 544 / 600;
		expect(stub.countOps("fit")).toBe(0);
		expect(stub.getScale()).toBeCloseTo(cssScale * 2, 6);
		expect(stub.getPan()).toEqual({ x: 0, y: 0 });
	});

	it("caps the css scale for near-coincident payloads", () => {
		globalWithDpr.devicePixelRatio = 1;
		const container = { clientWidth: 800, clientHeight: 600 };
		const { engine, stub } = makeEngine(container);
		engine.ingest(payload([node("A", 0, 0), node("B", 2, 2)]));
		expect(stub.getScale()).toBeCloseTo(1.5, 6); // MAX_FIT_CSS_SCALE
	});

	it("falls back to the vendor fit when the container is unmeasurable", () => {
		const { engine, stub } = makeEngine(null);
		engine.ingest(payload(spread));
		expect(stub.countOps("fit")).toBe(1);
	});

	it("falls back to the vendor fit when positions are absent (sims)", () => {
		const container = { clientWidth: 800, clientHeight: 600 };
		let stub: StubBackend | undefined;
		const engine = new GraphEngine(
			(o) => {
				stub = new StubBackend(o);
				return stub;
			},
			{ ...OPTS, layout: "d3Force", container },
		);
		const unpositioned = [
			{ ...node("A"), x: undefined, y: undefined },
			{ ...node("B"), x: undefined, y: undefined },
		];
		engine.ingest(payload(unpositioned, [], { positionsIncluded: false }));
		expect(stub?.countOps("fit")).toBe(1);
	});

	it("still fits exactly ONCE across ingests (camera law unchanged)", () => {
		globalWithDpr.devicePixelRatio = 1;
		const container = { clientWidth: 800, clientHeight: 600 };
		const { engine, stub } = makeEngine(container);
		engine.ingest(payload(spread));
		const zoomAfterFit = stub.getScale();
		stub.setZoomAndPan(0.123, 5, 5); // member gesture
		engine.ingest(payload([...spread, node("D", 50, 50)]));
		expect(stub.getScale()).toBe(0.123); // no refit, gesture preserved
		expect(zoomAfterFit).not.toBe(0.123);
	});
});
