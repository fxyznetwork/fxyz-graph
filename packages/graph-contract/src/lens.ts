/**
 * LensSpec v1 — the Perspective-JSON registry entry (DESIGN-V2 §5/§6).
 * One schema drives public/member/operator variants of every lens.
 */

import type { DataRole, MeasureKind, TokenLayer } from "./enums";
import type { Tier } from "./payload";
import type { Audience, GraphRef, NodeKind } from "./refs";

/**
 * Algorithm → property → style-rule (Bloom's pattern, via the
 * graph-algorithms encoding bridge): a rule binds a measure/property to a
 * visual channel through the grammar — renderers never see algorithms.
 */
export interface StyleRule {
	/**
	 * What the rule reads: a MeasureKind, the categorical `community`
	 * assignment (GraphNodeV1.community — deterministic palette color, #1082),
	 * or a node property name.
	 */
	source: MeasureKind | "community" | `prop:${string}`;
	/** Which grammar channel it drives. */
	channel: "color" | "size" | "brightness" | "edgeClass" | "shape";
	/** Data-role binding when channel is color (locked accents). */
	role?: DataRole;
}

/**
 * One legend chip: what a lens's visual encoding MEANS, declared where the
 * encoding is declared (Train 16 — the wiring audit found community palette
 * and role accents rendering with zero explanation on every surface). The
 * contract stays presentation-free: entries name the encoding; renderers own
 * swatch pixels.
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
	/** Seed-first entry (grammar law 1): every lens lands on a bounded seed. */
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
	/** Budgeted top-N labels (engine law 6). */
	labelBudget: number;
	/**
	 * Which measure ranks nodes for the label budget (label salience).
	 * Unset = degree-first (the workbench default). Community-summary lenses
	 * set "count" so the biggest communities carry the labels, not the
	 * highest-degree ones (2026-07-17: top-80-by-degree surfaced low-exemplar
	 * "… cluster" fallbacks while exemplar-named communities went unlabeled).
	 */
	labelRankMeasure?: MeasureKind;
	tier: Tier;
	/**
	 * Token layers this lens may include (codex finding 15). Mixing
	 * position + settlement requires listing BOTH — an explicit declaration,
	 * displayed side by side, never converted.
	 */
	allowedTokenLayers?: TokenLayer[];
	timeModel?: { enabled: boolean; replay?: boolean };
	/** Matrices beat node-link >20 nodes except path tasks — the table twin. */
	tableTwin?: boolean;
}

export class LensSpecViolation extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LensSpecViolation";
	}
}

/** Minimal structural validation — the law harness owns the deep checks. */
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
