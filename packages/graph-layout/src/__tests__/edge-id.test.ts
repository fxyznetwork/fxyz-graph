/**
 * sliceEdgeId must stay byte-compatible with the @fxyz/graph-contract EdgeId
 * grammar (refs.ts makeEdgeId). The contract is a devDependency here on
 * purpose: parity is a test-time concern; graph-layout's identity space carries
 * no runtime contract dependency.
 */
import { type GraphRef, makeEdgeId } from "@fxyz/graph-contract";
import { sliceEdgeId } from "../source/edge-id";

describe("sliceEdgeId", () => {
	it("matches the contract EdgeId grammar exactly", () => {
		// Contract endpoints are GraphRefs; bare slice keys stand in for them.
		// Parity means: same type + same endpoint strings → same bytes.
		const viaContract = makeEdgeId(
			"USES_CURRENCY",
			"brazil" as GraphRef,
			"USD" as GraphRef,
		);
		expect(sliceEdgeId("USES_CURRENCY", "brazil", "USD")).toBe(viaContract);
	});

	it("matches the contract grammar with a discriminator", () => {
		const viaContract = makeEdgeId(
			"IN_COUNTRY",
			"drex" as GraphRef,
			"brazil" as GraphRef,
			"synth",
		);
		expect(sliceEdgeId("IN_COUNTRY", "drex", "brazil", "synth")).toBe(
			viaContract,
		);
	});

	it("is deterministic and direction-sensitive", () => {
		expect(sliceEdgeId("PEGS_TO", "USDC", "USD")).toBe(
			sliceEdgeId("PEGS_TO", "USDC", "USD"),
		);
		expect(sliceEdgeId("PEGS_TO", "USDC", "USD")).not.toBe(
			sliceEdgeId("PEGS_TO", "USD", "USDC"),
		);
	});

	it("keys parallel same-type edges identically (mappers must dedupe)", () => {
		expect(sliceEdgeId("MEMBER_OF", "bankA", "bis")).toBe(
			sliceEdgeId("MEMBER_OF", "bankA", "bis"),
		);
	});
});
