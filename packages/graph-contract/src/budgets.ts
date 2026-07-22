/**
 * No folklore constants (engine law 11): every numeric threshold carries
 * provenance — a measured date + harness ref, or an explicit 'provisional'
 * marker. CI flags bare numbers; this type is the carrier.
 */

import type { Tier } from "./payload";

export interface ProvenancedNumber {
	value: number;
	provenance: "measured" | "provisional";
	/** Where the number came from — harness path, audit doc, or 'guess'. */
	source: string;
	/** ISO date when measured (required when provenance === 'measured'). */
	measuredAt?: string;
}

export type TierBudgets = Record<
	Tier,
	{ maxNodes: ProvenancedNumber; labelBudget: ProvenancedNumber }
>;

/**
 * Default budgets (DESIGN-V2 §4 table). Injectable — consumers may override,
 * but overrides must themselves be ProvenancedNumbers.
 */
export const DEFAULT_TIER_BUDGETS: TierBudgets = {
	peek: {
		maxNodes: {
			value: 60,
			provenance: "provisional",
			source: "DESIGN-V2 §4 — measure in P2 canary",
		},
		labelBudget: {
			value: 20,
			provenance: "provisional",
			source: "DESIGN-V2 §4",
		},
	},
	chip: {
		maxNodes: {
			value: 60,
			provenance: "provisional",
			source: "DESIGN-V2 §4 — measure in P2 canary",
		},
		labelBudget: {
			value: 20,
			provenance: "provisional",
			source: "DESIGN-V2 §4",
		},
	},
	tile: {
		maxNodes: {
			value: 200,
			provenance: "measured",
			source:
				"dashboard-network-mini.tsx canvas budget (readable labels below WEBGL seam)",
			measuredAt: "2026-07-08",
		},
		labelBudget: {
			value: 40,
			provenance: "provisional",
			source: "DESIGN-V2 §4",
		},
	},
	drawer: {
		maxNodes: {
			value: 300,
			provenance: "provisional",
			source: "GraphDrawer.tsx:137 existing budget — re-verify in P2",
		},
		labelBudget: {
			value: 80,
			provenance: "measured",
			source: "computeLabelLod research budget (graph-label-research.md)",
			measuredAt: "2026-06-20",
		},
	},
	panel: {
		maxNodes: {
			value: 2000,
			provenance: "measured",
			source:
				"fair benchmark addendum: canvas comfortable to ~1–2k (31fps @2k); WEBGL_THRESHOLD=500 directionally right",
			measuredAt: "2026-07-15",
		},
		labelBudget: {
			value: 120,
			provenance: "measured",
			source: "computeLabelLod research budget",
			measuredAt: "2026-06-20",
		},
	},
	workbench: {
		maxNodes: {
			value: 10_000,
			provenance: "measured",
			source:
				"fair benchmark: clean NVL 60/60fps @10k (docs/audits/2026-07-15-graph-renderer-benchmark/results-fair.json); ALSO the tm#751 payload/OOM budget",
			measuredAt: "2026-07-15",
		},
		labelBudget: {
			value: 200,
			provenance: "measured",
			source: "fair benchmark: top-200 overlay ≈ free over WebGL cloud",
			measuredAt: "2026-07-15",
		},
	},
	atlas: {
		maxNodes: {
			value: 50_000,
			provenance: "measured",
			source:
				"fair benchmark: 50k idle 55.5fps under free+precomputed (M1 Max CEILING — device-adaptive cap required; median-device re-run owed before final ruling)",
			measuredAt: "2026-07-15",
		},
		labelBudget: {
			value: 200,
			provenance: "measured",
			source: "fair benchmark label overlay cells",
			measuredAt: "2026-07-15",
		},
	},
};
