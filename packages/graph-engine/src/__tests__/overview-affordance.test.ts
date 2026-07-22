/**
 * Overview affordance behaviors: three defects that made a public overview
 * feel dead, locked as tests —
 *
 *  1. selection must REACH the renderer (the pre-fix backend kept it in an
 *     internal Set, so taps were invisible on canvas),
 *  2. lens colors must arrive as concrete colors (canvas/WebGL can't parse
 *     `var(--fx-role-*)` — the backend boundary resolves them),
 *  3. real names outrank synthesized "<label> cluster" fallbacks in the
 *     label budget, and identical generic text can't wall the overlay.
 */

import type { GraphNodeV1 } from "@fxyz/graph-contract";
import type { BackendConstructOptions } from "../backend/contract";
import { NvlBackend, type NvlLikeInstance } from "../backend/nvl";
import { pickLabeledNodes } from "../labels/budget";
import { applyStyleRules } from "../lens/apply";

const OPTS: BackendConstructOptions = {
	container: null,
	renderer: "canvas",
	layout: "free",
	disableTelemetry: true,
};

function makeFakeNvl(): {
	instance: NvlLikeInstance;
	updates: Array<Record<string, unknown>>;
} {
	const updates: Array<Record<string, unknown>> = [];
	const instance: NvlLikeInstance = {
		getNodes: () => [],
		getRelationships: () => [],
		setNodePositions: () => {},
		addAndUpdateElementsInGraph: (ns = []) => {
			for (const n of ns as Array<Record<string, unknown>>) updates.push(n);
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
	return { instance, updates };
}

describe("selection reaches the renderer (the one lawful highlight)", () => {
	it("pushes selected:true/false deltas into the renderer instance", () => {
		const { instance, updates } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);

		backend.setSelectedNodeIds(["a"]);
		expect(updates).toEqual([{ id: "a", selected: true }]);

		updates.length = 0;
		backend.setSelectedNodeIds(["b"]);
		expect(updates).toEqual(
			expect.arrayContaining([
				{ id: "b", selected: true },
				{ id: "a", selected: false },
			]),
		);
		expect(updates).toHaveLength(2);

		// No-op reselect pushes nothing (delta, not broadcast).
		updates.length = 0;
		backend.setSelectedNodeIds(["b"]);
		expect(updates).toHaveLength(0);
	});

	it("deselectAll clears the rendered flags", () => {
		const { instance, updates } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		backend.setSelectedNodeIds(["a", "b"]);
		updates.length = 0;
		backend.deselectAll();
		expect(updates).toEqual(
			expect.arrayContaining([
				{ id: "a", selected: false },
				{ id: "b", selected: false },
			]),
		);
	});
});

describe("CSS-var colors resolve at the backend boundary", () => {
	it("falls back to the declared fallback when the var can't resolve", () => {
		const { instance, updates } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		backend.addAndUpdateElementsInGraph(
			[{ id: "n1", color: "var(--fx-role-money, #fbbc7a)" }],
			[],
		);
		expect(updates[0]?.color).toBe("#fbbc7a");
	});

	it("drops an unresolvable var with no fallback instead of passing garbage", () => {
		const { instance, updates } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		backend.addAndUpdateElementsInGraph(
			[{ id: "n1", color: "var(--fx-role-money)" }],
			[],
		);
		expect(updates[0]).toEqual({ id: "n1" });
	});

	it("passes concrete colors through untouched", () => {
		const { instance, updates } = makeFakeNvl();
		const backend = new NvlBackend(OPTS, () => instance);
		backend.addAndUpdateElementsInGraph(
			[{ id: "n1", color: "rgba(148, 163, 184, 0.35)" }],
			[],
		);
		expect(updates[0]?.color).toBe("rgba(148, 163, 184, 0.35)");
	});
});

describe("per-node role colors (prop:roles rule)", () => {
	it("binds each node's own first role to its accent token", () => {
		const nodes: GraphNodeV1[] = [
			{
				id: "community:v1:a",
				kind: "community",
				label: "US Dollar · Switzerland",
				roles: ["money"],
				provenance: "real",
			},
			{
				id: "community:v1:b",
				kind: "community",
				label: "Concept cluster",
				roles: ["topology"],
				provenance: "real",
			},
			{
				id: "community:v1:c",
				kind: "community",
				label: "roleless",
				provenance: "real",
			},
		];
		const patches = applyStyleRules(nodes, [
			{ source: "prop:roles", channel: "color" },
		]);
		expect(patches.get("community:v1:a")?.color).toBe("var(--fx-role-money)");
		expect(patches.get("community:v1:b")?.color).toBe(
			"var(--fx-role-topology)",
		);
		expect(patches.get("community:v1:c")?.color).toBeUndefined();
	});
});

describe("named-first label budget", () => {
	const mk = (
		id: string,
		label: string,
		count: number,
		quality?: "named" | "generic",
	): GraphNodeV1 => ({
		id: `community:v1:${id}`,
		kind: "community",
		label,
		...(quality !== undefined && { labelQuality: quality }),
		measures: { count },
		provenance: "real",
	});

	it("real names outrank generic fallbacks at any measure", () => {
		const picked = pickLabeledNodes(
			[
				mk("g1", "Concept cluster", 5000, "generic"),
				mk("n1", "financial institution · PartyRole", 40, "named"),
				mk("g2", "Concept cluster", 4000, "generic"),
				mk("n2", "US Dollar · Switzerland", 30, "named"),
			],
			3,
			"count",
		);
		expect(picked.map((n) => n.label)).toEqual([
			"financial institution · PartyRole",
			"US Dollar · Switzerland",
			"Concept cluster",
		]);
	});

	it("identical generic text renders at most twice", () => {
		const picked = pickLabeledNodes(
			[
				mk("g1", "Concept cluster", 500, "generic"),
				mk("g2", "Concept cluster", 400, "generic"),
				mk("g3", "Concept cluster", 300, "generic"),
				mk("g4", "Star cluster", 200, "generic"),
			],
			10,
			"count",
		);
		expect(
			picked.filter((n) => n.label === "Concept cluster"),
		).toHaveLength(2);
		expect(picked.map((n) => n.label)).toContain("Star cluster");
	});

	it("payloads without labelQuality keep the pure measure ranking", () => {
		const picked = pickLabeledNodes(
			[mk("a", "small", 1), mk("b", "big", 100), mk("c", "mid", 10)],
			2,
			"count",
		);
		expect(picked.map((n) => n.label)).toEqual(["big", "mid"]);
	});
});
