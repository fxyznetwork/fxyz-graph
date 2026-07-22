import {
	GraphRefViolation,
	isGraphRef,
	makeCodeRef,
	makeCommunityRef,
	makeCorridorRef,
	makeEdgeId,
	makeRef,
	parseRef,
} from "../refs";

describe("GraphRef minting (stable identity)", () => {
	it("mints kind:key refs and round-trips through parseRef", () => {
		const ref = makeRef("currency", "EUR");
		expect(ref).toBe("currency:EUR");
		expect(parseRef(ref)).toEqual({ kind: "currency", key: "EUR" });
	});

	it("accepts legitimate digit-bearing keys (star catalogs)", () => {
		expect(makeRef("star", "HIP24436")).toBe("star:HIP24436");
	});

	it("REJECTS the positional-synthetic member pattern", () => {
		expect(() => makeRef("star", "member-giant-42")).toThrow(GraphRefViolation);
		expect(() => makeRef("member", "member-dwarf-7")).toThrow(
			GraphRefViolation,
		);
	});

	it("rejects empty keys and unknown kinds", () => {
		expect(() => makeRef("currency", "  ")).toThrow(GraphRefViolation);
		// @ts-expect-error — unknown kind is a type error AND a runtime error
		expect(() => makeRef("wallet", "x")).toThrow(GraphRefViolation);
	});

	it("rejects colon-bearing keys outside the code kind", () => {
		expect(() => makeRef("concept", "a:b")).toThrow(GraphRefViolation);
		expect(makeCodeRef("packages/graph-contract:src/refs.ts")).toBe(
			"code:packages/graph-contract/src/refs.ts",
		);
	});

	it("isGraphRef guards strings", () => {
		expect(isGraphRef("currency:EUR")).toBe(true);
		expect(isGraphRef("nonsense")).toBe(false);
		expect(isGraphRef(42)).toBe(false);
	});
});

describe("community refs are version-qualified and ephemeral", () => {
	it("carries the dataVersion in the key", () => {
		expect(makeCommunityRef("2026-07-15", 42)).toBe("community:v2026-07-15-42");
	});
	it("refuses missing version or id", () => {
		expect(() => makeCommunityRef("", 42)).toThrow(GraphRefViolation);
		expect(() => makeCommunityRef("v1", "")).toThrow(GraphRefViolation);
	});
	it("different snapshots yield different refs for the same community id", () => {
		expect(makeCommunityRef("a", 1)).not.toBe(makeCommunityRef("b", 1));
	});
});

describe("corridor refs are direction-preserving and qualified", () => {
	it("normalizes spelling but preserves direction", () => {
		expect(makeCorridorRef({ send: "eur", receive: "brl" })).toBe(
			"corridor:EUR→BRL",
		);
		expect(makeCorridorRef({ send: "EUR", receive: "BRL" })).not.toBe(
			makeCorridorRef({ send: "BRL", receive: "EUR" }),
		);
	});
	it("keeps the two corridor families distinct", () => {
		const routing = makeCorridorRef({
			send: "EUR",
			receive: "BRL",
			family: "routing",
		});
		const p2p = makeCorridorRef({ send: "EUR", receive: "BRL", family: "p2p" });
		expect(routing).not.toBe(p2p);
	});
});

describe("edge ids are deterministic with discriminators", () => {
	const a = makeRef("currency", "EUR");
	const b = makeRef("currency", "BRL");
	it("is stable for the same inputs", () => {
		expect(makeEdgeId("QUOTES", a, b)).toBe(makeEdgeId("QUOTES", a, b));
	});
	it("parallel edges separate via discriminator", () => {
		expect(makeEdgeId("QUOTES", a, b, "binance")).not.toBe(
			makeEdgeId("QUOTES", a, b, "okx"),
		);
	});
});
