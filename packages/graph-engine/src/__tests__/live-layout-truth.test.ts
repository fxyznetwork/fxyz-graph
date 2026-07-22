/**
 * Live-layout truth laws (#1055).
 *
 * The FX walk defect: under a client sim (payload without server positions)
 * the tap hit-index was built from payload coordinates — which don't exist —
 * so every tap missed, and `NvlBackend.isLayoutMoving()` returned true
 * FOREVER (layout-name stub), so settle could never be observed. Two laws
 * lock the fix:
 *
 *  1. Motion truth: the adapter derives isLayoutMoving from the vendor's own
 *     onLayoutDone callback (the real lever, audit RC6) — moving from
 *     construction, settled on done, re-heated by new data.
 *  2. Position truth: hit-testing reads the SAME position source the
 *     renderer draws from — payload under `free`, live backend positions
 *     under a sim (mergeLivePositions is the one join).
 */

import type { GraphNodeV1 } from "@fxyz/graph-contract";
import type { BackendConstructOptions } from "../backend/contract";
import {
	createNvlBackendFactory,
	type NvlLikeCallbacks,
	type NvlLikeInstance,
} from "../backend/nvl";
import { mergeLivePositions, NodeHitIndex, type PaneView } from "../react/view";

function makeFakeNvl(
	getPositions?: () => Array<{ id: string; x: number; y: number }>,
): {
	instance: NvlLikeInstance;
	captured: { callbacks?: NvlLikeCallbacks };
} {
	const captured: { callbacks?: NvlLikeCallbacks } = {};
	const instance: NvlLikeInstance = {
		getNodes: () => [],
		getRelationships: () => [],
		getNodePositions: () => getPositions?.() ?? [],
		setNodePositions: () => {},
		addAndUpdateElementsInGraph: () => {},
		removeNodesWithIds: () => {},
		removeRelationshipsWithIds: () => {},
		setZoomAndPan: () => {},
		getScale: () => 1,
		getPan: () => ({ x: 0, y: 0 }),
		fit: () => {},
		setRenderer: () => {},
		destroy: () => {},
	};
	return { instance, captured };
}

function makeBackend(
	layout: BackendConstructOptions["layout"],
	getPositions?: () => Array<{ id: string; x: number; y: number }>,
) {
	const { instance, captured } = makeFakeNvl(getPositions);
	const factory = createNvlBackendFactory((_c, _n, _r, _o, callbacks) => {
		captured.callbacks = callbacks;
		return instance;
	});
	const backend = factory({
		container: null,
		renderer: "canvas",
		layout,
		disableTelemetry: true,
	});
	return { backend, captured };
}

describe("motion truth — isLayoutMoving rides the vendor onLayoutDone (#1055)", () => {
	it("passes a callbacks object through the factory seam", () => {
		const { captured } = makeBackend("d3Force");
		expect(captured.callbacks).toBeDefined();
		expect(typeof captured.callbacks?.onLayoutDone).toBe("function");
	});

	it("a sim is moving from construction, settled on onLayoutDone", () => {
		const { backend, captured } = makeBackend("d3Force");
		expect(backend.isLayoutMoving()).toBe(true); // the old stub also said true…
		captured.callbacks?.onLayoutDone?.();
		expect(backend.isLayoutMoving()).toBe(false); // …but could NEVER say false
	});

	it("new data re-heats the sim; the next onLayoutDone settles it again", () => {
		const { backend, captured } = makeBackend("d3Force");
		captured.callbacks?.onLayoutDone?.();
		expect(backend.isLayoutMoving()).toBe(false);
		backend.addAndUpdateElementsInGraph(
			[{ id: "currency:USD" }],
			[],
		);
		expect(backend.isLayoutMoving()).toBe(true);
		captured.callbacks?.onLayoutDone?.();
		expect(backend.isLayoutMoving()).toBe(false);
	});

	it("onLayoutComputing(true) and onLayoutStep mark motion", () => {
		const { backend, captured } = makeBackend("d3Force");
		captured.callbacks?.onLayoutDone?.();
		captured.callbacks?.onLayoutComputing?.(true);
		expect(backend.isLayoutMoving()).toBe(true);
		captured.callbacks?.onLayoutDone?.();
		captured.callbacks?.onLayoutStep?.([]);
		expect(backend.isLayoutMoving()).toBe(true);
	});

	it("`free` is never moving — settle is known at load, callbacks or not", () => {
		const { backend } = makeBackend("free");
		expect(backend.isLayoutMoving()).toBe(false);
		backend.addAndUpdateElementsInGraph([{ id: "currency:USD" }], []);
		expect(backend.isLayoutMoving()).toBe(false);
	});

	it("quiescence fallback: settles when positions stop moving and the vendor never says done", () => {
		// Prod-observed: NVL's d3Force path (alphaDecay 0) never emits
		// onLayoutDone — motion truth must come from observed positions.
		let positions = [{ id: "a", x: 0, y: 0 }];
		const { backend } = makeBackend("d3Force", () =>
			positions.map((p) => ({ ...p })),
		);
		expect(backend.isLayoutMoving()).toBe(true); // first sample
		positions = [{ id: "a", x: 5, y: 0 }];
		expect(backend.isLayoutMoving()).toBe(true); // moved
		for (let i = 0; i < 9; i += 1) {
			expect(backend.isLayoutMoving()).toBe(true); // stable but < 10 samples
		}
		expect(backend.isLayoutMoving()).toBe(false); // 10th stable sample settles
		expect(backend.isLayoutMoving()).toBe(false); // and stays settled
	});

	it("re-heating resets the quiescence counter, not just the flag", () => {
		let positions = [{ id: "a", x: 0, y: 0 }];
		const { backend } = makeBackend("d3Force", () =>
			positions.map((p) => ({ ...p })),
		);
		for (let i = 0; i < 11; i += 1) backend.isLayoutMoving();
		expect(backend.isLayoutMoving()).toBe(false); // settled by quiescence
		backend.addAndUpdateElementsInGraph([{ id: "b" }], []);
		expect(backend.isLayoutMoving()).toBe(true); // sampling restarts fresh
		positions = [{ id: "a", x: 9, y: 9 }];
		expect(backend.isLayoutMoving()).toBe(true);
	});
});

describe("position truth — hit-testing reads the renderer's position source (#1055)", () => {
	// The FX shape: contract nodes WITHOUT coordinates (client sim owns layout).
	const simNodes = [
		{ id: "currency:USD", kind: "currency", label: "USD", provenance: "real" },
		{ id: "currency:EUR", kind: "currency", label: "EUR", provenance: "real" },
	] as GraphNodeV1[];

	const view: PaneView = {
		scale: 1,
		panX: 0,
		panY: 0,
		width: 800,
		height: 600,
		dpr: 1,
	};

	it("DOCUMENTS THE DEFECT: a payload-only index under a sim hits nothing", () => {
		const index = new NodeHitIndex(simNodes);
		expect(index.size).toBe(0);
		expect(index.hit(view, 400, 300)).toBeNull();
	});

	it("merged live positions make taps land (the fix)", () => {
		const live = {
			"currency:USD": { x: 0, y: 0 }, // world origin → screen center
			"currency:EUR": { x: 120, y: -40 },
		};
		const index = new NodeHitIndex(mergeLivePositions(simNodes, live));
		expect(index.size).toBe(2);
		expect(index.hit(view, 400, 300)?.id).toBe("currency:USD");
		expect(index.hit(view, 520, 260)?.id).toBe("currency:EUR");
	});

	it("merge keeps payload coordinates for ids the backend doesn't know", () => {
		const positioned = [
			{ ...simNodes[0], x: 10, y: 10 },
			simNodes[1],
		] as GraphNodeV1[];
		const merged = mergeLivePositions(positioned, {
			"currency:EUR": { x: 5, y: 5 },
		});
		expect(merged[0]?.x).toBe(10);
		expect(merged[1]?.x).toBe(5);
	});

	it("an empty live map is a no-op (free layouts pay nothing)", () => {
		const merged = mergeLivePositions(simNodes, {});
		expect(merged).toBe(simNodes);
	});
});
