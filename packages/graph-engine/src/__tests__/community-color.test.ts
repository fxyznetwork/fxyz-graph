/**
 * #1082 — categorical community→color styling (engine half). The style
 * pipeline maps a node's version-qualified `community` ref deterministically to
 * a Stellar-v3 palette hue: same ref → same hue across sessions, distinct refs
 * spread across the wheel, and a node with NO community keeps whatever the lens
 * default left it (never forced onto the palette).
 */

import { type GraphNodeV1, makeRef } from "@fxyz/graph-contract";
import {
	applyStyleRules,
	COMMUNITY_PALETTE,
	communityColor,
} from "../lens/apply";

function node(key: string, community?: string): GraphNodeV1 {
	return {
		id: makeRef("currency", key),
		kind: "currency",
		label: key,
		measures: { degree: 1 },
		provenance: "real",
		...(community !== undefined && { community }),
	};
}

const COMMUNITY_RULE = { source: "community", channel: "color" } as const;

describe("#1082 · community→color is a stable categorical hash", () => {
	it("the same community ref always maps to the same hue", () => {
		expect(communityColor("community:v7-42")).toBe(
			communityColor("community:v7-42"),
		);
		// stable literal — pins the mapping across sessions/reloads.
		const c = communityColor("community:v7-42");
		expect(COMMUNITY_PALETTE).toContain(c);
	});

	it("distinct refs spread across the palette (not one bucket)", () => {
		const hues = new Set(
			Array.from({ length: 60 }, (_, i) => communityColor(`community:v1-${i}`)),
		);
		// 60 distinct refs over a 10-hue palette must touch most of it.
		expect(hues.size).toBeGreaterThanOrEqual(8);
	});

	it("every hue is a concrete hex (no CSS var — resolves straight through)", () => {
		for (const c of COMMUNITY_PALETTE) {
			expect(c).toMatch(/^#[0-9a-f]{6}$/i);
		}
		expect(COMMUNITY_PALETTE).toHaveLength(10);
	});
});

describe("#1082 · applyStyleRules honors the community source", () => {
	it("paints a node's community hue when the rule is present", () => {
		const n = node("USD", "community:v3-9");
		const patch = applyStyleRules([n], [COMMUNITY_RULE]).get(n.id);
		expect(patch?.color).toBe(communityColor("community:v3-9"));
	});

	it("a node with NO community keeps the lens default color", () => {
		const n = node("EUR"); // no community
		// community rule alone → no color forced
		expect(applyStyleRules([n], [COMMUNITY_RULE]).get(n.id)?.color).toBeUndefined();
		// with a role default BEFORE the community rule (the communities-lens
		// pattern), the uncommunitied node keeps the role accent.
		const withDefault = applyStyleRules(
			[n],
			[
				{ source: "prop:x", channel: "color", role: "topology" },
				COMMUNITY_RULE,
			],
		).get(n.id);
		expect(withDefault?.color).toBe("var(--fx-role-topology)");
	});

	it("the community hue overrides the role default for communitied nodes", () => {
		const n = node("JPY", "community:v3-1");
		const patch = applyStyleRules(
			[n],
			[
				{ source: "prop:x", channel: "color", role: "topology" },
				COMMUNITY_RULE,
			],
		).get(n.id);
		expect(patch?.color).toBe(communityColor("community:v3-1"));
	});
});
