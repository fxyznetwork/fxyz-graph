/**
 * K-calibration size, locked as tests.
 *
 * Measured against the canvas renderer, exact at zoom 1 AND 2: the renderer
 * draws `size` as a RADIUS with NO dpr division (css_radius = size · Z)
 * while positions map through css = (Z/dpr)·(world − pan) + c/2. Raw lens
 * sizes therefore render at size·dpr WORLD radius — 2× the intended diameter
 * at dpr 1, 4× at dpr 2 (a visibly oversized node cloud).
 *
 * Rule: the backend boundary hands the renderer `size/(2·dpr)`, making the
 * engine's size channel a true dpr-independent world-space DIAMETER —
 * drawn world radius = size/2, matching GraphPane's label anchorRadius
 * (size/2) exactly.
 */

import type { BackendConstructOptions } from "../backend/contract";
import { NvlBackend, type NvlLikeInstance } from "../backend/nvl";

const OPTS: BackendConstructOptions = {
	container: null,
	renderer: "canvas",
	layout: "free",
	disableTelemetry: true,
};

function makeFakeNvl() {
	const nodePatches: Array<Record<string, unknown>> = [];
	const instance: NvlLikeInstance = {
		getNodes: () => [],
		getRelationships: () => [],
		setNodePositions: () => {},
		addAndUpdateElementsInGraph: (ns = []) => {
			for (const n of ns as Array<Record<string, unknown>>) nodePatches.push(n);
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
	return { instance, nodePatches };
}

const g = globalThis as { devicePixelRatio?: number };

describe("renderer boundary normalizes size to a world-space diameter", () => {
	afterEach(() => {
		g.devicePixelRatio = undefined;
	});

	it("divides size by 2·dpr (dpr 2: the measured 4× case)", () => {
		g.devicePixelRatio = 2;
		const { instance, nodePatches } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		backend.addAndUpdateElementsInGraph(
			[
				{ id: "a", size: 48 },
				{ id: "b", size: 6 },
			],
			[],
		);
		expect(nodePatches.map((n) => n.size)).toEqual([12, 1.5]);
	});

	it("divides size by 2 at dpr 1 (renderer size = radius, ours = diameter)", () => {
		g.devicePixelRatio = undefined; // node env — deviceDpr() falls back to 1
		const { instance, nodePatches } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		backend.addAndUpdateElementsInGraph([{ id: "a", size: 25 }], []);
		expect(nodePatches[0].size).toBe(12.5);
	});

	it("patches without a size (or with a non-numeric size) pass untouched", () => {
		g.devicePixelRatio = 2;
		const { instance, nodePatches } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		backend.addAndUpdateElementsInGraph(
			[{ id: "a", color: "#aec2f8" }, { id: "b", size: Number.NaN }],
			[],
		);
		expect(nodePatches[0].size).toBeUndefined();
		expect(Number.isNaN(nodePatches[1].size as number)).toBe(true);
	});
});
