/**
 * Adversarial tests — the other half of the sensitive-data and confidentiality
 * enforcement. They feed hostile nodes through every audience and assert the
 * serializer throws (sensitive data) or strips (totals) — never serves.
 */

import type { GraphEdgeV1, GraphNodeV1 } from "../payload";
import { isCdnCacheable } from "../payload";
import { makeEdgeId, makeRef } from "../refs";
import {
	type BuildPayloadInput,
	buildPayload,
	SerializerViolation,
} from "../serializer";

const eur: GraphNodeV1 = {
	id: makeRef("currency", "EUR"),
	kind: "currency",
	label: "Euro",
	provenance: "real",
};
const brl: GraphNodeV1 = {
	id: makeRef("currency", "BRL"),
	kind: "currency",
	label: "Brazilian Real",
	provenance: "real",
};
const edge: GraphEdgeV1 = {
	id: makeEdgeId("QUOTES", eur.id, brl.id),
	source: eur.id,
	target: brl.id,
	type: "QUOTES",
	provenance: "real",
};

function baseInput(
	overrides: Partial<BuildPayloadInput> = {},
): BuildPayloadInput {
	return {
		audience: "public",
		tier: "panel",
		lens: "market-map",
		scope: "overview",
		dataVersion: "dv1",
		aclVersion: "acl1",
		nodes: [eur, brl],
		edges: [edge],
		coverage: { framing: "curated", totals: { nodes: 6000, edges: 12000 } },
		sampled: true,
		positionsIncluded: false,
		...overrides,
	};
}

describe("sensitive-data choke point (absolute)", () => {
	it("throws on a decentralized identifier in a label, on EVERY audience", () => {
		const hostile: GraphNodeV1 = {
			...eur,
			id: makeRef("concept", "leaky"),
			label: "did:example:examplenode01",
		};
		for (const audience of ["public", "member", "operator"] as const) {
			expect(() =>
				buildPayload(baseInput({ audience, nodes: [hostile], edges: [] })),
			).toThrow(SerializerViolation);
		}
	});

	it("throws on an email in a label", () => {
		const hostile: GraphNodeV1 = {
			...eur,
			id: makeRef("concept", "leaky2"),
			label: "reach me at someone@example.com",
		};
		expect(() =>
			buildPayload(baseInput({ nodes: [hostile], edges: [] })),
		).toThrow(SerializerViolation);
	});

	it("rejects internally-keyed member refs outside operator projections", () => {
		const didMember: GraphNodeV1 = {
			id: "member:did-example-abc123" as GraphNodeV1["id"],
			kind: "member",
			label: "Operator View Member",
			provenance: "real",
		};
		expect(() =>
			buildPayload(baseInput({ nodes: [didMember], edges: [] })),
		).toThrow(SerializerViolation);
		expect(() =>
			buildPayload(
				baseInput({ audience: "member", nodes: [didMember], edges: [] }),
			),
		).toThrow(SerializerViolation);
		// operator projection may carry member-kind refs (still no identifier in label)
		expect(() =>
			buildPayload(
				baseInput({ audience: "operator", nodes: [didMember], edges: [] }),
			),
		).not.toThrow();
	});
});

describe("confidential-by-design (closed MeasureKind)", () => {
	it("throws on a balance-shaped measure key — no enum member can carry it", () => {
		const hostile = {
			...eur,
			measures: { balance: 123_456 },
		} as unknown as GraphNodeV1;
		expect(() => buildPayload(baseInput({ nodes: [hostile, brl] }))).toThrow(
			SerializerViolation,
		);
	});

	it("accepts closed-enum measures with null-never-zero semantics", () => {
		const honest: GraphNodeV1 = {
			...eur,
			measures: { "cost-bps": null, degree: 12 },
		};
		expect(() =>
			buildPayload(baseInput({ nodes: [honest, brl] })),
		).not.toThrow();
	});

	it("throws on settlement states outside the closed enum", () => {
		const hostileEdge = {
			...edge,
			settlementState: "PVP_COMPLETE",
		} as unknown as GraphEdgeV1;
		expect(() => buildPayload(baseInput({ edges: [hostileEdge] }))).toThrow(
			SerializerViolation,
		);
	});

	it("enforces the lens token-layer declaration", () => {
		const settlementToken: GraphNodeV1 = {
			...eur,
			id: makeRef("token", "SETTLE"),
			label: "Settlement token",
			tokenLayer: "settlement",
		};
		expect(() =>
			buildPayload(
				baseInput({
					nodes: [settlementToken, brl],
					edges: [],
					allowedTokenLayers: ["position"],
				}),
			),
		).toThrow(SerializerViolation);
	});
});

describe("audience-gated totals + CDN rule", () => {
	it("strips totals from public payloads (framing label survives)", () => {
		const publicPayload = buildPayload(baseInput());
		expect(publicPayload.coverage.framing).toBe("curated");
		expect(publicPayload.coverage.totals).toBeUndefined();
	});

	it("keeps totals for member/operator payloads", () => {
		const memberPayload = buildPayload(baseInput({ audience: "member" }));
		expect(memberPayload.coverage.totals).toEqual({
			nodes: 6000,
			edges: 12000,
		});
	});

	it("only public payloads are CDN-cacheable; cacheKey carries audience+acl", () => {
		const pub = buildPayload(baseInput());
		const member = buildPayload(baseInput({ audience: "member" }));
		expect(isCdnCacheable(pub)).toBe(true);
		expect(isCdnCacheable(member)).toBe(false);
		expect(pub.cacheKey).toContain("public");
		expect(pub.cacheKey).toContain("acl1");
		expect(pub.cacheKey).not.toBe(member.cacheKey);
	});

	it("refuses legacyIdMap on public payloads", () => {
		expect(() =>
			buildPayload(baseInput({ legacyIdMap: { [eur.id]: "4:abc:123" } })),
		).toThrow(SerializerViolation);
		expect(() =>
			buildPayload(
				baseInput({
					audience: "member",
					legacyIdMap: { [eur.id]: "4:abc:123" },
				}),
			),
		).not.toThrow();
	});
});

describe("identity integrity", () => {
	it("throws on duplicate node refs", () => {
		expect(() => buildPayload(baseInput({ nodes: [eur, eur] }))).toThrow(
			SerializerViolation,
		);
	});

	it("throws on dangling edges (forked id spaces surface here)", () => {
		const dangling: GraphEdgeV1 = {
			...edge,
			id: makeEdgeId("QUOTES", eur.id, makeRef("currency", "NGN")),
			target: makeRef("currency", "NGN"),
		};
		expect(() => buildPayload(baseInput({ edges: [edge, dangling] }))).toThrow(
			SerializerViolation,
		);
	});

	it("positionsIncluded=true requires finite coords on every node", () => {
		const positioned = { ...eur, x: 1, y: 2 };
		expect(() =>
			buildPayload(
				baseInput({ nodes: [positioned, brl], positionsIncluded: true }),
			),
		).toThrow(SerializerViolation);
		const bothPositioned = [positioned, { ...brl, x: 3, y: 4 }];
		expect(() =>
			buildPayload(
				baseInput({ nodes: bothPositioned, positionsIncluded: true }),
			),
		).not.toThrow();
	});
});
