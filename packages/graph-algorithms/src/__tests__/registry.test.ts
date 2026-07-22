import {
	createRegistry,
	DuplicateAlgorithmError,
	GroundingError,
} from "../registry";
import type { Algorithm } from "../types";

const published: Algorithm = {
	id: "noop",
	family: "centrality",
	paramSchema: {},
	venues: ["client-ts"],
	defaultEncodingChannel: "brightness",
	resultKind: "scores",
	run: async () => ({ kind: "scores", values: new Map<string, number>() }),
};

// A ƒxyz-coined metric — registration must prove its :Concept is active.
const coined: Algorithm = {
	...published,
	id: "network-r0",
	groundingConceptId: "claim-network-r0",
};

describe("AlgorithmRegistry", () => {
	it("registers a published algorithm with no grounding", () => {
		const r = createRegistry().register(published);
		expect(r.has("noop")).toBe(true);
		expect(r.size).toBe(1);
		expect(r.get("noop")?.family).toBe("centrality");
	});

	it("throws on duplicate id", () => {
		const r = createRegistry().register(published);
		expect(() => r.register(published)).toThrow(DuplicateAlgorithmError);
	});

	it("fail-closed: a coined metric cannot register without a grounding checker", () => {
		expect(() => createRegistry().register(coined)).toThrow(GroundingError);
	});

	it("refuses a coined metric whose :Concept is not active", () => {
		const r = createRegistry({ groundingChecker: () => false });
		expect(() => r.register(coined)).toThrow(GroundingError);
	});

	it("registers a coined metric whose :Concept is active", () => {
		const r = createRegistry({
			groundingChecker: (id) => id === "claim-network-r0",
		});
		r.register(coined);
		expect(r.has("network-r0")).toBe(true);
	});

	it("lists, filters by family, and reports families", () => {
		const r = createRegistry().register(published);
		expect(r.list()).toHaveLength(1);
		expect(r.list("centrality")).toHaveLength(1);
		expect(r.list("community")).toHaveLength(0);
		expect(r.families()).toEqual(["centrality"]);
	});
});
