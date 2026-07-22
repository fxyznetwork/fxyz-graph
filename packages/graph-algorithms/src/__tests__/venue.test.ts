import type { Algorithm, Venue } from "../types";
import { deriveVenue } from "../venue";

function algo(
	venues: readonly Venue[],
	maxWorkingSet?: Partial<Record<Venue, number>>,
): Algorithm {
	return {
		id: "t",
		family: "centrality",
		paramSchema: {},
		venues,
		maxWorkingSet,
		defaultEncodingChannel: "brightness",
		resultKind: "scores",
		run: async () => ({ kind: "scores", values: new Map<string, number>() }),
	};
}

describe("deriveVenue", () => {
	it("picks the cheapest (closest-to-render) venue that fits", () => {
		const d = deriveVenue(algo(["client-ts", "server-query"]), 100);
		expect(d.venue).toBe("client-ts");
		expect(d.refused).toBe(false);
	});

	it("escalates to the server when the client envelope is exceeded", () => {
		const d = deriveVenue(algo(["client-ts", "server-query"]), 10_000);
		expect(d.venue).toBe("server-query");
		expect(d.refused).toBe(false);
	});

	it("refuses (never hangs) when every available envelope is exceeded", () => {
		const d = deriveVenue(algo(["client-ts", "server-query"]), 100_000);
		expect(d.venue).toBeNull();
		expect(d.refused).toBe(true);
		expect(d.reason).toMatch(/Collapse to super-nodes|exceeds/);
	});

	it("treats server-native as unavailable by default (engine not installed)", () => {
		const d = deriveVenue(algo(["server-native"]), 100_000);
		expect(d.venue).toBeNull();
		expect(d.refused).toBe(true);
		expect(d.reason).toMatch(/No venue available/);
	});

	it("selects server-native once the deployment declares it available", () => {
		const d = deriveVenue(algo(["server-native"]), 100_000, {
			availableVenues: ["client-ts", "server-query", "server-native"],
		});
		expect(d.venue).toBe("server-native");
		expect(d.refused).toBe(false);
	});

	it("honors a per-algorithm envelope override", () => {
		const d = deriveVenue(algo(["client-ts"], { "client-ts": 50 }), 100);
		expect(d.venue).toBeNull();
		expect(d.refused).toBe(true);
	});
});
