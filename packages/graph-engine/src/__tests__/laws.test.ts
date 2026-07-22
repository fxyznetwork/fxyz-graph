/**
 * The invariant harness: the engine's core invariants as acceptance tests.
 * Invariants ship before features — a rewrite that regresses any of these is
 * not a rewrite, it is a repeat.
 *
 * Invariants whose FULL assertion needs a live surface carry the strongest
 * unit-level slice testable here — never silently narrowed.
 */

import {
	type BuildPayloadInput,
	buildPayload,
	DEFAULT_TIER_BUDGETS,
	type GraphEdgeV1,
	type GraphNodeV1,
	type GraphPayloadV1,
	makeEdgeId,
	makeRef,
} from "@fxyz/graph-contract";
import { type BackendConstructOptions } from "../backend/contract";
import { StubBackend } from "../backend/stub";
import { EngineViolation, GraphEngine } from "../core/engine";
import { PositionStore } from "../identity/stores";
import { SpatialGrid, throttle } from "../interaction/hit-index";
import { pickLabeledNodes } from "../labels/budget";
import {
	DEFAULT_LAYOUT_POLICY,
	LayoutPolicyViolation,
	resolveLayout,
} from "../layout/policy";
import { applyStyleRules, provenanceVisual } from "../lens/apply";

// ── shared fixtures ─────────────────────────────────────────────────────────

const OPTS: BackendConstructOptions = {
	container: null,
	renderer: "webgl",
	layout: "free",
	disableTelemetry: true,
};

function node(key: string, x = 0, y = 0, degree = 1): GraphNodeV1 {
	return {
		id: makeRef("currency", key),
		kind: "currency",
		label: key,
		measures: { degree },
		x,
		y,
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

function makeEngine() {
	let stub: StubBackend | undefined;
	const engine = new GraphEngine((o) => {
		stub = new StubBackend(o);
		return stub;
	}, OPTS);
	if (!stub) throw new Error("factory not called");
	return { engine, stub };
}

// ── the laws ────────────────────────────────────────────────────────────────

describe("budgets stay within safe ceilings", () => {
	it("no tier budget approaches a runaway node count", () => {
		for (const tier of Object.values(DEFAULT_TIER_BUDGETS)) {
			expect(tier.maxNodes.value).toBeLessThan(100_000);
		}
	});
});

describe("sensitive-data gates are absolute", () => {
	it("engine re-scans labels even behind the serializer (defense in depth)", () => {
		const hostile = payload([node("EUR")]);
		hostile.nodes[0] = { ...hostile.nodes[0], label: "did:example:examplenode02" };
		const { engine } = makeEngine();
		expect(() => engine.ingest(hostile)).toThrow(EngineViolation);
	});
});

describe("budgets enforced server-side; client slice = failure", () => {
	it("an over-budget payload throws loud instead of slicing", () => {
		const tooMany = Array.from({ length: 61 }, (_, i) => node(`C${i}`, i, i));
		const { engine } = makeEngine();
		expect(() => engine.ingest(payload(tooMany, [], { tier: "peek" }))).toThrow(
			EngineViolation,
		);
	});
});

describe("server layout past the measured N", () => {
	it("large payloads without positions are refused, never client-scattered", () => {
		const big = {
			positionsIncluded: false,
			nodes: Array.from({ length: 2001 }, (_, i) => node(`C${i}`)),
		};
		expect(() => resolveLayout(DEFAULT_LAYOUT_POLICY, big)).toThrow(
			LayoutPolicyViolation,
		);
	});
	it("positions → free; small no-position graphs may opt into the sim", () => {
		expect(
			resolveLayout(DEFAULT_LAYOUT_POLICY, {
				positionsIncluded: true,
				nodes: [node("EUR")],
			}),
		).toBe("free");
		expect(
			resolveLayout(DEFAULT_LAYOUT_POLICY, {
				positionsIncluded: false,
				nodes: [node("EUR")],
			}),
		).toBe("d3Force");
	});
});

describe("labels are a budgeted overlay (ONE label system)", () => {
	it("label selection is bounded by the budget, independent of N", () => {
		const nodes = Array.from({ length: 500 }, (_, i) => node(`C${i}`, 0, 0, i));
		const picked = pickLabeledNodes(nodes, 200);
		expect(picked).toHaveLength(200);
		expect(picked[0].measures?.degree).toBe(499); // top-degree first
	});
	it("is deterministic across identical payloads", () => {
		const nodes = Array.from({ length: 50 }, (_, i) => node(`C${i}`, 0, 0, 5));
		expect(pickLabeledNodes(nodes, 10)).toEqual(pickLabeledNodes(nodes, 10));
	});
	it("labelRankMeasure re-ranks salience: count beats degree on community tiers", () => {
		// A high-degree tiny community must not steal the label slot from an
		// exemplar-named major.
		const major: GraphNodeV1 = {
			...node("USD-major"),
			measures: { degree: 2, count: 5000 },
		};
		const noisy: GraphNodeV1 = {
			...node("tiny-hub"),
			measures: { degree: 40, count: 3 },
		};
		expect(pickLabeledNodes([major, noisy], 1)[0].label).toBe("tiny-hub");
		expect(pickLabeledNodes([major, noisy], 1, "count")[0].label).toBe(
			"USD-major",
		);
	});
	it("labelRankMeasure falls back to degree when a node lacks the measure", () => {
		const unmeasured: GraphNodeV1 = {
			...node("no-count"),
			measures: { degree: 10 },
		};
		const counted: GraphNodeV1 = {
			...node("counted"),
			measures: { degree: 1, count: 5 },
		};
		// no-count scores via its degree fallback (10 > 5) — absent measures
		// degrade, they never zero a node out of the ranking.
		expect(pickLabeledNodes([unmeasured, counted], 1, "count")[0].label).toBe(
			"no-count",
		);
	});
});

describe("telemetry disabled at every construction site", () => {
	it("a backend refuses construction with telemetry on", () => {
		const evil = {
			...OPTS,
			disableTelemetry: false,
		} as unknown as BackendConstructOptions;
		expect(() => new StubBackend(evil)).toThrow(/telemetry/);
	});
});

describe("incremental only — data change never re-inits", () => {
	it("two ingests → one construction, diff ops only", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([node("EUR", 1, 1), node("BRL", 2, 2)]));
		engine.ingest(payload([node("EUR", 1, 1), node("NGN", 3, 3)]));
		expect(stub.countOps("construct")).toBe(1);
		expect(stub.countOps("destroy")).toBe(0);
		expect(stub.countOps("addAndUpdate")).toBeGreaterThanOrEqual(2);
		// BRL was removed by the diff, not by reconstruction
		expect(stub.getNodeById("currency:BRL")).toBeUndefined();
		expect(stub.getNodeById("currency:NGN")).toBeDefined();
	});
});

describe("stable config identity (the per-render reinit class)", () => {
	it("engine options are frozen — mid-life mutation throws", () => {
		const { engine } = makeEngine();
		expect(() => {
			(engine.options as { renderer: string }).renderer = "canvas";
		}).toThrow(TypeError);
	});
});

describe("interaction budget", () => {
	it("spatial queries touch only nearby cells, independent of N", () => {
		const points = Array.from({ length: 10_000 }, (_, i) => ({
			id: `p${i}`,
			x: (i % 100) * 10,
			y: Math.floor(i / 100) * 10,
		}));
		const grid = new SpatialGrid(points, 64);
		expect(grid.size).toBe(10_000);
		expect(grid.cellsTouched(500, 500, 20)).toBeLessThanOrEqual(4);
		const hits = grid.query(500, 500, 15);
		for (const h of hits) {
			expect(Math.hypot(h.x - 500, h.y - 500)).toBeLessThanOrEqual(15);
		}
	});
	it("hover handlers throttle at ≥25ms zoom parity", () => {
		let t = 0;
		let calls = 0;
		const handler = throttle(
			() => (calls += 1),
			25,
			() => t,
		);
		for (t = 0; t <= 100; t += 5) handler();
		expect(calls).toBeLessThanOrEqual(5); // 0,25,50,75,100
	});
});

describe("no folklore constants — every threshold carries provenance", () => {
	it("every default budget has provenance + source; measured ⇒ dated", () => {
		for (const [tier, budget] of Object.entries(DEFAULT_TIER_BUDGETS)) {
			for (const n of [budget.maxNodes, budget.labelBudget]) {
				expect(["measured", "provisional"]).toContain(n.provenance);
				expect(n.source.length).toBeGreaterThan(5);
				if (n.provenance === "measured") {
					expect(n.measuredAt).toBeDefined();
				}
			}
			expect(tier).toBeTruthy();
		}
	});
	it("the layout-policy ceiling is provenance-annotated too", () => {
		expect(DEFAULT_LAYOUT_POLICY.clientSimMaxNodes.provenance).toBe("measured");
		expect(DEFAULT_LAYOUT_POLICY.clientSimMaxNodes.measuredAt).toBeDefined();
	});
});

// backend swappability — full scenario suite in backend-swap.test.ts

describe("one identity contract — positions join across payloads by ref", () => {
	it("a position computed under one payload joins another by GraphRef", () => {
		const store = new PositionStore();
		store.setMany({ "currency:EUR": { x: 10, y: 20 } });
		// a different fetch/tier later references the same ref
		expect(store.get(makeRef("currency", "EUR"))).toEqual({ x: 10, y: 20 });
	});
});

describe("one control layer — lens changes never reconstruct", () => {
	it("applyLens N times → zero new constructions, delta-bounded pushes", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([node("EUR", 1, 1, 5), node("BRL", 2, 2, 3)]));
		const pushesBefore = stub.countOps("addAndUpdate");
		const changed1 = engine.applyLens([{ source: "degree", channel: "size" }]);
		const changed2 = engine.applyLens([{ source: "degree", channel: "size" }]);
		expect(stub.countOps("construct")).toBe(1);
		expect(changed1.length).toBe(2);
		expect(changed2.length).toBe(0); // identical lens → zero re-push
		expect(stub.countOps("addAndUpdate")).toBe(pushesBefore + 1);
	});

	it("falsification storm: the full interaction vocabulary against a live engine → exactly ONE construction, zero destroys", () => {
		const { engine, stub } = makeEngine();
		// The storm mirrors a demanding session: data swaps, lens flips, node +
		// explicit-edge selection churn, deselects.
		const a = payload([node("EUR", 1, 1, 5), node("BRL", 2, 2, 3)]);
		engine.ingest(a);
		for (let i = 0; i < 5; i += 1) {
			engine.applyLens([{ source: "degree", channel: "size" }]);
			engine.applyLens([{ source: "degree", channel: "brightness" }]);
			engine.select([makeRef("currency", "EUR")]);
			engine.selectEdges([]);
			engine.select([]);
		}
		// A different payload (add + remove) diffs into the SAME instance.
		const b = payload([node("EUR", 1, 1, 5), node("JPY", 4, 4, 2)]);
		engine.ingest(b);
		engine.select([makeRef("currency", "JPY")]);
		expect(stub.countOps("construct")).toBe(1);
		expect(stub.countOps("destroy")).toBe(0);
	});
});

describe("explicit versioned payload contract", () => {
	it("rejects unknown versions and tiers", () => {
		const { engine } = makeEngine();
		const good = payload([node("EUR", 1, 1)]);
		expect(() =>
			engine.ingest({ ...good, version: 2 as unknown as 1 }),
		).toThrow(EngineViolation);
		expect(() =>
			engine.ingest({ ...good, tier: "mega" as unknown as "panel" }),
		).toThrow(EngineViolation);
	});
});

describe("provenance renders (a data-bearing lens shows real/illustrative)", () => {
	it("illustrative data is visually distinct by construction", () => {
		expect(provenanceVisual("illustrative").dashed).toBe(true);
		expect(provenanceVisual("real").dashed).toBe(false);
		const patches = applyStyleRules(
			[{ ...node("EUR"), provenance: "illustrative" }],
			[],
		);
		expect(patches.get(makeRef("currency", "EUR"))?.provenanceBadge).toBe(
			"illustrative",
		);
	});
});

describe("confidential-by-design (absolute)", () => {
	it("a balance-shaped measure is refused at ingest even if upstream slipped", () => {
		const p = payload([node("EUR", 1, 1)]);
		(p.nodes[0].measures as Record<string, number>).balance = 999;
		const { engine } = makeEngine();
		expect(() => engine.ingest(p)).toThrow(EngineViolation);
	});
});

describe("edge fixtures stay honest", () => {
	it("payload edges ride deterministic ids", () => {
		const a = node("EUR", 1, 1);
		const b = node("BRL", 2, 2);
		const e: GraphEdgeV1 = {
			id: makeEdgeId("QUOTES", a.id, b.id),
			source: a.id,
			target: b.id,
			type: "QUOTES",
			provenance: "real",
		};
		const { engine, stub } = makeEngine();
		engine.ingest(payload([a, b], [e]));
		expect(stub.getRelationships()).toHaveLength(1);
	});
});

describe("member drag is session-local", () => {
	it("override moves + pins with ZERO reconstruction, and survives a re-ingest", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([node("EUR", 10, 10), node("USD", 50, 50)]));
		const ref = makeRef("currency", "EUR");
		engine.overrideNodePosition(ref, 200, 300);
		expect(stub.getNodePositions()[ref]).toEqual({ x: 200, y: 300 });
		expect(stub.pinnedIds()).toContain(ref);
		expect(engine.positions.get(ref)).toEqual({ x: 200, y: 300 });
		// Data refresh (the lens-flip/expand path): the server push re-lands
		// EUR at (10,10), then the override re-applies on top — a member's
		// pin never snaps back.
		engine.ingest(payload([node("EUR", 10, 10), node("USD", 50, 50)]));
		expect(stub.getNodePositions()[ref]).toEqual({ x: 200, y: 300 });
		expect(stub.countOps("construct")).toBe(1);
		expect(stub.countOps("destroy")).toBe(0);
	});

	it("clearPositionOverrides unpins and restores the server truth", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([node("EUR", 10, 10), node("USD", 50, 50)]));
		const ref = makeRef("currency", "EUR");
		engine.overrideNodePosition(ref, 200, 300);
		engine.clearPositionOverrides();
		expect(stub.getNodePositions()[ref]).toEqual({ x: 10, y: 10 });
		expect(stub.pinnedIds()).toHaveLength(0);
		expect(engine.positions.get(ref)).toEqual({ x: 10, y: 10 });
		expect(engine.overriddenPositions()).toEqual({});
	});

	it("non-finite drags are refused; overrides after destroy throw", () => {
		const { engine, stub } = makeEngine();
		engine.ingest(payload([node("EUR", 10, 10)]));
		const ref = makeRef("currency", "EUR");
		engine.overrideNodePosition(ref, Number.NaN, 5);
		expect(stub.getNodePositions()[ref]).toEqual({ x: 10, y: 10 });
		engine.destroy();
		expect(() => engine.overrideNodePosition(ref, 1, 1)).toThrow(
			EngineViolation,
		);
	});
});
