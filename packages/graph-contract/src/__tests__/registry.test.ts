/**
 * Lens registry v1 — law tests. Every entry must be a valid LensSpec, ids
 * must be unique and match their map key, public lenses must be structurally
 * PII-safe, and label budgets must stay inside the measured 80/120/200 law.
 */

import { validateLensSpec } from "../lens";
import {
	getLensSpec,
	isKnownLensId,
	KNOWN_LENS_IDS,
	LENS_REGISTRY,
	LENS_REGISTRY_VERSION,
} from "../registry";

describe("lens registry v1", () => {
	it("carries version 1", () => {
		expect(LENS_REGISTRY_VERSION).toBe(1);
	});

	it("registers today's real lenses and nothing speculative", () => {
		// The fx-* family entered WITH its surface (the #971 fold: /graph?view=fx
		// rides GraphPane) — real-or-remove holds.
		expect([...KNOWN_LENS_IDS].sort()).toEqual(
			[
				"communities",
				"core-periphery",
				"public-overview",
				"raw",
				"fx-correlation",
				"fx-mst",
				"fx-pmfg",
				"fx-arbitrage",
				"fx-route",
				"market",
				"fibo",
				"org",
				"provenance",
				// tm #1123: the public entity-ego panel lens (entity detail pages).
				"ego",
			].sort(),
		);
	});

	it("every entry validates and its map key matches its id", () => {
		for (const [key, spec] of LENS_REGISTRY) {
			expect(spec.id).toBe(key);
			expect(() => validateLensSpec(spec)).not.toThrow();
		}
	});

	it("public lenses never declare the operator-only member kind", () => {
		for (const [, spec] of LENS_REGISTRY) {
			if (spec.audience === "public") {
				expect(spec.nodeKinds).not.toContain("member");
			}
		}
	});

	it("the member kind (DID-keyed) appears in NO lens — operator lenses do not exist yet", () => {
		for (const [, spec] of LENS_REGISTRY) {
			expect(spec.nodeKinds).not.toContain("member");
		}
	});

	it("label budgets stay inside the measured 80/120/200 law", () => {
		for (const [, spec] of LENS_REGISTRY) {
			expect([80, 120, 200]).toContain(spec.labelBudget);
		}
	});

	it("entries are frozen — the registry is a catalog, not mutable state", () => {
		const raw = getLensSpec("raw");
		expect(raw).not.toBeNull();
		expect(Object.isFrozen(raw)).toBe(true);
	});

	it("lookup helpers agree", () => {
		expect(isKnownLensId("communities")).toBe(true);
		expect(isKnownLensId("money-map")).toBe(false);
		expect(getLensSpec("nope")).toBeNull();
	});

	it("the public overview lens serves ONLY the precomputed summary tier", () => {
		const spec = getLensSpec("public-overview");
		expect(spec?.nodeKinds).toEqual(["community"]);
		expect(spec?.audience).toBe("public");
	});

	it("the communities lens colours BY community (#1082) with a role default", () => {
		const spec = getLensSpec("communities");
		expect(spec).not.toBeNull();
		const colorRules = spec?.styleRules.filter((r) => r.channel === "color");
		// the categorical community rule is present…
		expect(colorRules).toContainEqual({
			source: "community",
			channel: "color",
		});
		// …after the topology-role default (no-community nodes keep the accent).
		const communityIdx =
			spec?.styleRules.findIndex((r) => r.source === "community") ?? -1;
		const roleIdx =
			spec?.styleRules.findIndex((r) => r.role === "topology") ?? -1;
		expect(roleIdx).toBeGreaterThanOrEqual(0);
		expect(communityIdx).toBeGreaterThan(roleIdx);
	});

	it("the market lens is a public, role-coloured, degree-sized map", () => {
		const spec = getLensSpec("market");
		expect(spec).not.toBeNull();
		expect(spec?.audience).toBe("public");
		expect(spec?.nodeKinds).not.toContain("member");
		// role, never route — each node binds its own data role.
		expect(spec?.styleRules).toContainEqual({
			source: "prop:roles",
			channel: "color",
		});
		expect(spec?.styleRules).toContainEqual({
			source: "degree",
			channel: "size",
		});
	});

	it("the fibo lens is a member, fibo-kind, workbench-tier ontology map (#1103)", () => {
		const spec = getLensSpec("fibo");
		expect(spec).not.toBeNull();
		expect(spec?.audience).toBe("member");
		expect(spec?.tier).toBe("workbench");
		expect(spec?.nodeKinds).toEqual(["fibo"]);
		expect(spec?.relTypes).toEqual(["SUBCLASS_OF"]);
		// role, never route — every FIBO class binds its money role.
		expect(spec?.styleRules).toContainEqual({
			source: "prop:roles",
			channel: "color",
		});
		expect(spec?.styleRules).toContainEqual({
			source: "degree",
			channel: "size",
		});
	});

	it("the org lens is a member, circle/role/domain-kind, workbench-tier governance map", () => {
		const spec = getLensSpec("org");
		expect(spec).not.toBeNull();
		expect(spec?.audience).toBe("member");
		expect(spec?.tier).toBe("workbench");
		expect(spec?.nodeKinds).toEqual(["circle", "role", "domain"]);
		expect(spec?.relTypes).toEqual([
			"PARENT_OF",
			"HAS_ROLE",
			"OWNS_DOMAIN",
			"ACCOUNTABLE_FOR",
		]);
		// role, never route — every governance node binds its governance role.
		expect(spec?.styleRules).toContainEqual({
			source: "prop:roles",
			channel: "color",
		});
		expect(spec?.styleRules).toContainEqual({
			source: "degree",
			channel: "size",
		});
	});

	it("the provenance lens is a member, concept-kind, workbench-tier canon-lineage map", () => {
		const spec = getLensSpec("provenance");
		expect(spec).not.toBeNull();
		expect(spec?.audience).toBe("member");
		expect(spec?.tier).toBe("workbench");
		expect(spec?.nodeKinds).toEqual(["concept"]);
		// The full lineage rel-type superset — BOTH writer spellings deliberately.
		expect(spec?.relTypes).toEqual([
			"SUPERSEDES",
			"SUPERSEDED_BY",
			"SUCCEEDED_BY",
			"MERGES_FROM",
			"DEDUPS_TO",
			"PROMOTED_FROM",
			"PROMOTED_FROM_ARCHIVE",
			"DERIVED_FROM",
		]);
		// role, never route — every concept binds its topology role.
		expect(spec?.styleRules).toContainEqual({
			source: "prop:roles",
			channel: "color",
		});
		expect(spec?.styleRules).toContainEqual({
			source: "degree",
			channel: "size",
		});
	});
});
