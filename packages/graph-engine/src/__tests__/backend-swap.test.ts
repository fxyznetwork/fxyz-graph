/**
 * Backend swappability: the same scenario runs against the stub
 * backend and the renderer adapter (driving a FAKE NvlLikeInstance), and the
 * observable results must be identical. This is the seam that makes any
 * future renderer change a backend swap, never another integration rewrite.
 */

import {
	buildPayload,
	type GraphNodeV1,
	type GraphPayloadV1,
	makeEdgeId,
	makeRef,
} from "@fxyz/graph-contract";
import type {
	BackendConstructOptions,
	BackendFactory,
} from "../backend/contract";
import { createNvlBackendFactory, type NvlLikeInstance } from "../backend/nvl";
import { createStubBackend } from "../backend/stub";
import { GraphEngine } from "../core/engine";

const OPTS: BackendConstructOptions = {
	container: null,
	renderer: "webgl",
	layout: "free",
	disableTelemetry: true,
};

/** Minimal faithful fake of the renderer surface the adapter touches. */
function makeFakeNvl(): { instance: NvlLikeInstance; log: string[] } {
	const nodes = new Map<string, { id: string; x?: number; y?: number }>();
	const rels = new Map<string, { id: string; from?: string; to?: string }>();
	const log: string[] = [];
	const instance: NvlLikeInstance = {
		getNodes: () => [...nodes.values()],
		getRelationships: () => [...rels.values()],
		getNodePositions: () =>
			[...nodes.values()]
				.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y))
				.map((n) => ({ id: n.id, x: n.x as number, y: n.y as number })),
		setNodePositions: (positions) => {
			const list = (positions ?? []) as Array<{
				id: string | number;
				x: number;
				y: number;
			}>;
			log.push(`setNodePositions:${list.length}`);
			for (const p of list) {
				const n = nodes.get(String(p.id));
				if (n) {
					n.x = p.x;
					n.y = p.y;
				}
			}
		},
		addAndUpdateElementsInGraph: (ns = [], rs = []) => {
			log.push(`add:${ns.length}/${rs.length}`);
			for (const raw of ns as Array<{ id: string | number }>) {
				const id = String(raw.id);
				nodes.set(id, { ...nodes.get(id), ...(raw as object), id });
			}
			for (const raw of rs as Array<{ id: string | number }>) {
				const id = String(raw.id);
				rels.set(id, { ...rels.get(id), ...(raw as object), id });
			}
		},
		removeNodesWithIds: (ids) => {
			log.push(`removeNodes:${ids.length}`);
			for (const id of ids) nodes.delete(String(id));
		},
		removeRelationshipsWithIds: (ids) => {
			log.push(`removeRels:${ids.length}`);
			for (const id of ids) rels.delete(String(id));
		},
		setZoomAndPan: () => log.push("zoomPan"),
		getScale: () => 1,
		getPan: () => ({ x: 0, y: 0 }),
		fit: () => log.push("fit"),
		setRenderer: (r) => log.push(`setRenderer:${r}`),
		destroy: () => log.push("destroy"),
	};
	return { instance, log };
}

function scenarioPayloads(): GraphPayloadV1[] {
	const mk = (
		key: string,
		x: number,
		y: number,
		degree: number,
	): GraphNodeV1 => ({
		id: makeRef("currency", key),
		kind: "currency",
		label: key,
		measures: { degree },
		x,
		y,
		provenance: "real",
	});
	const eur = mk("EUR", 0, 0, 9);
	const brl = mk("BRL", 10, 0, 4);
	const ngn = mk("NGN", 0, 10, 2);
	const edgeAB = {
		id: makeEdgeId("QUOTES", eur.id, brl.id),
		source: eur.id,
		target: brl.id,
		type: "QUOTES",
		provenance: "real" as const,
	};
	const edgeAC = {
		id: makeEdgeId("QUOTES", eur.id, ngn.id),
		source: eur.id,
		target: ngn.id,
		type: "QUOTES",
		provenance: "real" as const,
	};
	const base = {
		audience: "member" as const,
		tier: "panel" as const,
		lens: "swap-test",
		scope: "t",
		dataVersion: "dv1",
		aclVersion: "acl1",
		coverage: { framing: "curated" as const },
		sampled: false,
		positionsIncluded: true,
	};
	return [
		buildPayload({ ...base, nodes: [eur, brl], edges: [edgeAB] }),
		// second ingest: BRL leaves, NGN arrives — exercises the diff both ways
		buildPayload({ ...base, nodes: [eur, ngn], edges: [edgeAC] }),
	];
}

function runScenario(factory: BackendFactory) {
	const engine = new GraphEngine(factory, OPTS);
	for (const p of scenarioPayloads()) engine.ingest(p);
	engine.applyLens([{ source: "degree", channel: "size" }]);
	engine.select([makeRef("currency", "EUR")]);
	const b = engine.backend;
	return {
		nodeIds: b
			.getNodes()
			.map((n) => n.id)
			.sort(),
		relIds: b
			.getRelationships()
			.map((r) => r.id)
			.sort(),
		positions: b.getNodePositions(),
		selection: b.getSelectedNodeIds(),
	};
}

describe("backend swappability — identical observables across backends", () => {
	it("stub and NVL-adapter backends converge on the same end state", () => {
		const { instance } = makeFakeNvl();
		const viaStub = runScenario(createStubBackend);
		const viaNvl = runScenario(createNvlBackendFactory(() => instance));

		expect(viaNvl.nodeIds).toEqual(viaStub.nodeIds);
		expect(viaNvl.relIds).toEqual(viaStub.relIds);
		expect(viaNvl.positions).toEqual(viaStub.positions);
		expect(viaNvl.selection).toEqual(viaStub.selection);
		// the diff removed BRL on both backends — never accumulate
		expect(viaStub.nodeIds).toEqual(["currency:EUR", "currency:NGN"]);
	});

	it("the adapter drives live setRenderer instead of destroy+recreate", () => {
		const { instance, log } = makeFakeNvl();
		const backend = createNvlBackendFactory(() => instance)(OPTS);
		backend.setRenderer("canvas");
		expect(log).toContain("setRenderer:canvas");
		expect(log).not.toContain("destroy");
	});
});
