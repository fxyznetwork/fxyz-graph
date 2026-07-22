/**
 * LensSpec v1 — one registry entry. A single schema drives the
 * public/member/operator variants of every lens.
 */

import type { DataRole, MeasureKind, TokenLayer } from "./enums";
import type { Tier } from "./payload";
import type { Audience, GraphRef, NodeKind } from "./refs";

/**
 * Algorithm → property → style-rule (via the graph-algorithms encoding
 * bridge): a rule binds a measure/property to a visual channel — renderers
 * never see algorithms.
 */
export interface StyleRule {
	/**
	 * What the rule reads: a MeasureKind, the categorical `community`
	 * assignment (GraphNodeV1.community — a deterministic palette color), or a
	 * node property name.
	 */
	source: MeasureKind | "community" | `prop:${string}`;
	/** Which visual channel it drives. */
	channel: "color" | "size" | "brightness" | "edgeClass" | "shape";
	/** Data-role binding when channel is color. */
	role?: DataRole;
}

/**
 * One legend chip: what a lens's visual encoding MEANS, declared where the
 * encoding is declared (so community palettes and role accents never render
 * without a key). The contract stays presentation-free: entries name the
 * encoding; renderers own swatch pixels.
 */
export type LegendEntry =
	| { encoding: "role"; role: DataRole; label: string }
	| { encoding: "community"; label: string }
	| { encoding: "size"; label: string }
	| { encoding: "brightness"; label: string };

export interface LensSpec {
	id: string;
	title: string;
	audience: Audience;
	/** Seed-first entry: every lens lands on a bounded seed. */
	seed:
		| { kind: "ref"; ref: GraphRef; depth: number }
		| { kind: "scope"; scope: string }
		| { kind: "savedView"; viewId: string };
	nodeKinds: NodeKind[];
	relTypes: string[];
	styleRules: StyleRule[];
	/**
	 * What the styleRules MEAN, as legend chips (optional — heroes and
	 * data-bearing lenses declare it; a lens with no legend renders no key).
	 */
	legend?: readonly LegendEntry[];
	/** Budgeted top-N labels. */
	labelBudget: number;
	/**
	 * Which measure ranks nodes for the label budget (label salience).
	 * Unset = degree-first (the workbench default). Community-summary lenses
	 * set "count" so the biggest communities carry the labels, not the
	 * highest-degree ones (degree ranking can surface low-exemplar "… cluster"
	 * fallbacks while exemplar-named communities go unlabeled).
	 */
	labelRankMeasure?: MeasureKind;
	tier: Tier;
	/**
	 * Token layers this lens may include. Mixing position + settlement requires
	 * listing BOTH — an explicit declaration, displayed side by side, never
	 * converted.
	 */
	allowedTokenLayers?: TokenLayer[];
	timeModel?: { enabled: boolean; replay?: boolean };
	/** Matrices beat node-link past ~20 nodes except path tasks — the table twin. */
	tableTwin?: boolean;
}

export class LensSpecViolation extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LensSpecViolation";
	}
}

/** Minimal structural validation — the test suite owns the deep checks. */
export function validateLensSpec(spec: LensSpec): LensSpec {
	if (!spec.id.trim()) throw new LensSpecViolation("lens id required");
	if (spec.labelBudget < 0) {
		throw new LensSpecViolation("labelBudget must be >= 0");
	}
	if (spec.nodeKinds.length === 0) {
		throw new LensSpecViolation(
			"a lens must declare its node kinds (allowlist, not everything)",
		);
	}
	if (spec.seed.kind === "ref" && spec.seed.depth < 0) {
		throw new LensSpecViolation("seed depth must be >= 0");
	}
	return spec;
}
