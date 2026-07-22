import {
	createRegistry,
	DuplicateAlgorithmError,
	RegistrationError,
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

// A guarded algorithm — registration must be approved by the guard.
const guarded: Algorithm = {
	...published,
	id: "network-r0",
	guardKey: "network-r0",
};

describe("AlgorithmRegistry", () => {
	it("registers an algorithm with no guard key", () => {
		const r = createRegistry().register(published);
		expect(r.has("noop")).toBe(true);
		expect(r.size).toBe(1);
		expect(r.get("noop")?.family).toBe("centrality");
	});

	it("throws on duplicate id", () => {
		const r = createRegistry().register(published);
		expect(() => r.register(published)).toThrow(DuplicateAlgorithmError);
	});

	it("fail-closed: a guarded algorithm cannot register without a guard", () => {
		expect(() => createRegistry().register(guarded)).toThrow(RegistrationError);
	});

	it("refuses a guarded algorithm the guard does not approve", () => {
		const r = createRegistry({ registrationGuard: () => false });
		expect(() => r.register(guarded)).toThrow(RegistrationError);
	});

	it("registers a guarded algorithm the guard approves", () => {
		const r = createRegistry({
			registrationGuard: (key) => key === "network-r0",
		});
		r.register(guarded);
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
