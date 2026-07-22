/**
 * tm #1099 — the workbench edge cache codec. The precompute writes the
 * slice's typed edge set once per fire; the API route decodes it instead of
 * paying the ~105s induced-edge scan per request. Encode and decode live in
 * the same module so the wire format can never fork.
 */

import type { Slice } from "../precompute-louvain-core";
import {
	decodeWorkbenchEdgeCache,
	encodeWorkbenchEdgeCache,
} from "../precompute-louvain-core";

function sliceWith(
	overrides: Partial<Slice>,
): Slice {
	return {
		ids: [],
		labelIdx: [],
		graph: null as unknown as Slice["graph"], // codec never touches it
		...overrides,
	};
}

describe("workbench edge cache codec (#1099)", () => {
	it("round-trips typed directed edges through the wire format", () => {
		const slice = sliceWith({
			ids: ["eid-a", "eid-b", "eid-c"],
			edgeTypes: ["CORRELATED", "SETTLES_VIA"],
			typedEdges: [
				[0, 1, 0, 0.8],
				[1, 2, 1, null],
				[0, 2, 0, null],
			],
		});
		const { payload, edgeCount } = encodeWorkbenchEdgeCache(slice);
		expect(edgeCount).toBe(3);
		expect(decodeWorkbenchEdgeCache(payload)).toEqual([
			{ sourceEid: "eid-a", targetEid: "eid-b", type: "CORRELATED", weight: 0.8 },
			{ sourceEid: "eid-b", targetEid: "eid-c", type: "SETTLES_VIA", weight: null },
			{ sourceEid: "eid-a", targetEid: "eid-c", type: "CORRELATED", weight: null },
		]);
	});

	it("a slice without typed edges encodes to an empty, decodable cache", () => {
		const { payload, edgeCount } = encodeWorkbenchEdgeCache(
			sliceWith({ ids: ["eid-a"] }),
		);
		expect(edgeCount).toBe(0);
		expect(decodeWorkbenchEdgeCache(payload)).toEqual([]);
	});

	it("decode refuses unknown versions and skips dangling indexes", () => {
		expect(
			decodeWorkbenchEdgeCache(
				JSON.stringify({ v: 2, eids: [], types: [], edges: [] }),
			),
		).toEqual([]);
		expect(
			decodeWorkbenchEdgeCache(
				JSON.stringify({
					v: 1,
					eids: ["eid-a"],
					types: ["T"],
					edges: [
						[0, 9, 0, null], // dangling target
						[0, 0, 5, null], // dangling type
					],
				}),
			),
		).toEqual([]);
	});
});
