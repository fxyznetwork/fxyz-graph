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
		const d = deriveVenue(algo(["client-ts", "server-cypher"]), 100);
		expect(d.venue).toBe("client-ts");
		expect(d.refused).toBe(false);
	});

	it("escalates to the server when the client envelope is exceeded", () => {
		const d = deriveVenue(algo(["client-ts", "server-cypher"]), 10_000);
		expect(d.venue).toBe("server-cypher");
		expect(d.refused).toBe(false);
	});

	it("refuses (never hangs) when every available envelope is exceeded", () => {
		const d = deriveVenue(algo(["client-ts", "server-cypher"]), 100_000);
		expect(d.venue).toBeNull();
		expect(d.refused).toBe(true);
		expect(d.reason).toMatch(/Collapse to super-nodes|exceeds/);
	});

	it("treats server-gds as unavailable by default (plugin not installed)", () => {
		const d = deriveVenue(algo(["server-gds"]), 100_000);
		expect(d.venue).toBeNull();
		expect(d.refused).toBe(true);
		expect(d.reason).toMatch(/No venue available/);
	});

	it("selects server-gds once the deployment declares it available", () => {
		const d = deriveVenue(algo(["server-gds"]), 100_000, {
			availableVenues: ["client-ts", "server-cypher", "server-gds"],
		});
		expect(d.venue).toBe("server-gds");
		expect(d.refused).toBe(false);
	});

	it("honors a per-algorithm envelope override", () => {
		const d = deriveVenue(algo(["client-ts"], { "client-ts": 50 }), 100);
		expect(d.venue).toBeNull();
		expect(d.refused).toBe(true);
	});
});
