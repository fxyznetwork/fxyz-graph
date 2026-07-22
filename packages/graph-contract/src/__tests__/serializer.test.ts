/**
 * Adversarial redaction tests — the other half of "structural" PII and
 * confidentiality enforcement (DESIGN-V2 §2; codex findings 5/6/7/13).
 * These feed hostile nodes through every audience and assert the serializer
 * throws (PII) or strips (totals) — never serves.
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

describe("PII choke point (law-3-pii — absolute)", () => {
	it("throws on a DID in a label, on EVERY audience", () => {
		const hostile: GraphNodeV1 = {
			...eur,
			id: makeRef("concept", "leaky"),
			label: "did:privy:examplenode01",
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
			label: "reach me at ken@example.com",
		};
		expect(() =>
			buildPayload(baseInput({ nodes: [hostile], edges: [] })),
		).toThrow(SerializerViolation);
	});

	it("rejects DID-keyed member refs outside operator projections", () => {
		const didMember: GraphNodeV1 = {
			id: "member:did-privy-abc123" as GraphNodeV1["id"],
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
		// operator projection may carry member-kind refs (still no DID in label)
		expect(() =>
			buildPayload(
				baseInput({ audience: "operator", nodes: [didMember], edges: [] }),
			),
		).not.toThrow();
	});
});

describe("confidential-by-design (law-17 — closed MeasureKind)", () => {
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

	it("enforces the lens token-layer declaration (codex 15)", () => {
		const florin: GraphNodeV1 = {
			...eur,
			id: makeRef("token", "FLORIN"),
			label: "Florin",
			tokenLayer: "florin-settlement",
		};
		expect(() =>
			buildPayload(
				baseInput({
					nodes: [florin, brl],
					edges: [],
					allowedTokenLayers: ["fxyz-position"],
				}),
			),
		).toThrow(SerializerViolation);
	});
});

describe("audience-gated totals + CDN rule (codex 6/13)", () => {
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

	it("refuses legacyIdMap on public payloads (codex 9)", () => {
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

describe("identity integrity (law-13)", () => {
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

	it("positionsIncluded=true requires finite coords on every node (law-5)", () => {
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
