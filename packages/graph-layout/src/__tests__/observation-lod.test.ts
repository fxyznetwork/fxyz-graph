import {
	isObservationLeafRow,
	normalizeObservationTime,
	providerDisplayName,
} from "../precompute-louvain-core";

describe("observation LOD — D7 bleed filter (isObservationLeafRow)", () => {
	it("keeps a pure base :Observation leaf", () => {
		expect(isObservationLeafRow(["Observation"])).toBe(true);
	});

	it("keeps the price/economic families", () => {
		expect(isObservationLeafRow(["Observation", "PriceObservation"])).toBe(true);
		expect(isObservationLeafRow(["Observation", "EconomicObservation"])).toBe(
			true,
		);
	});

	it("keeps the BIS sub-shapes and FX/policy/quarantine labels", () => {
		for (const l of [
			"FXMarketData",
			"PolicyRate",
			"QuarantinedObservation",
			"BISOTCDerivative",
			"BISCentralBankAssets",
			"BISConsumerPrice",
			"BISCreditData",
			"RealEstateIndex",
			"DebtServiceRatio",
		]) {
			expect(isObservationLeafRow(["Observation", l])).toBe(true);
		}
	});

	it("drops label-bleed rows carrying an entity label (finnhub/dune pattern)", () => {
		expect(isObservationLeafRow(["Observation", "DeFiProtocol"])).toBe(false);
		expect(isObservationLeafRow(["Observation", "Equity"])).toBe(false);
		expect(isObservationLeafRow(["Observation", "MarketIndex"])).toBe(false);
		expect(isObservationLeafRow(["Observation", "NFTCollection"])).toBe(false);
	});

	it("treats an empty label set as not-a-leaf", () => {
		expect(isObservationLeafRow([])).toBe(false);
	});
});

describe("observation LOD — D8 time normalization (normalizeObservationTime)", () => {
	it("prefers date, returning the ISO day", () => {
		expect(normalizeObservationTime("2024-01-15", "2024-Q1", 1_700_000_000)).toBe(
			"2024-01-15",
		);
	});

	it("truncates a datetime-shaped date string to the day", () => {
		expect(
			normalizeObservationTime("2024-01-15T09:30:00Z", null, null),
		).toBe("2024-01-15");
	});

	it("falls back to the period token when there is no date", () => {
		expect(normalizeObservationTime(null, "2024-Q1", null)).toBe("2024-Q1");
		expect(normalizeObservationTime(null, "2024-03", null)).toBe("2024-03");
	});

	it("converts an epoch-seconds timestamp to the ISO day", () => {
		// 1700000000 s = 2023-11-14T22:13:20Z
		expect(normalizeObservationTime(null, null, 1_700_000_000)).toBe(
			"2023-11-14",
		);
	});

	it("converts an epoch-milliseconds timestamp to the ISO day", () => {
		expect(normalizeObservationTime(null, null, 1_700_000_000_000)).toBe(
			"2023-11-14",
		);
	});

	it("handles a numeric-string timestamp", () => {
		expect(normalizeObservationTime(null, null, "1700000000")).toBe(
			"2023-11-14",
		);
	});

	it("handles a neo4j Date temporal wrapper (year/month/day)", () => {
		const neoDate = { year: 2024, month: 2, day: 5, toString: () => "2024-02-05" };
		expect(normalizeObservationTime(neoDate, null, null)).toBe("2024-02-05");
	});

	it("handles a neo4j Integer timestamp wrapper (toNumber)", () => {
		const neoInt = { toNumber: () => 1_700_000_000 };
		expect(normalizeObservationTime(null, null, neoInt)).toBe("2023-11-14");
	});

	it("returns null when the row carries no usable time", () => {
		expect(normalizeObservationTime(null, null, null)).toBeNull();
		expect(normalizeObservationTime("", "", null)).toBeNull();
	});
});

describe("observation LOD — D12 provider display names (providerDisplayName)", () => {
	it("keeps acronym providers uppercase", () => {
		expect(providerDisplayName("fred")).toBe("FRED");
		expect(providerDisplayName("bis")).toBe("BIS");
		expect(providerDisplayName("imf")).toBe("IMF");
		expect(providerDisplayName("oecd")).toBe("OECD");
	});

	it("carries conventional casing for named providers", () => {
		expect(providerDisplayName("coingecko")).toBe("CoinGecko");
		expect(providerDisplayName("cryptocompare")).toBe("CryptoCompare");
		expect(providerDisplayName("cbdc_tracker")).toBe("CBDC Tracker");
	});

	it("is case-insensitive on the registry lookup", () => {
		expect(providerDisplayName("FRED")).toBe("FRED");
		expect(providerDisplayName("CoinGecko")).toBe("CoinGecko");
	});

	it("title-cases unknown ids as a fallback", () => {
		expect(providerDisplayName("some_new_source")).toBe("Some New Source");
		expect(providerDisplayName("alpha")).toBe("Alpha");
	});
});
