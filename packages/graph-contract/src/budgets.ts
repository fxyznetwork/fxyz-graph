/**
 * No folklore constants: every numeric threshold carries provenance — a
 * measured date + source, or an explicit 'provisional' marker. This type is
 * the carrier so bare magic numbers never enter the budget table.
 */

import type { Tier } from "./payload";

export interface ProvenancedNumber {
	value: number;
	provenance: "measured" | "provisional";
	/** Where the number came from — a measurement, a prior budget, or a guess. */
	source: string;
	/** ISO date when measured (required when provenance === 'measured'). */
	measuredAt?: string;
}

export type TierBudgets = Record<
	Tier,
	{ maxNodes: ProvenancedNumber; labelBudget: ProvenancedNumber }
>;

/**
 * Default budgets. Injectable — consumers may override, but overrides must
 * themselves be ProvenancedNumbers.
 */
export const DEFAULT_TIER_BUDGETS: TierBudgets = {
	peek: {
		maxNodes: {
			value: 60,
			provenance: "provisional",
			source: "starting budget — measure under real load",
		},
		labelBudget: {
			value: 20,
			provenance: "provisional",
			source: "starting budget",
		},
	},
	chip: {
		maxNodes: {
			value: 60,
			provenance: "provisional",
			source: "starting budget — measure under real load",
		},
		labelBudget: {
			value: 20,
			provenance: "provisional",
			source: "starting budget",
		},
	},
	tile: {
		maxNodes: {
			value: 200,
			provenance: "measured",
			source: "mini-canvas budget (readable labels below the WebGL seam)",
			measuredAt: "2026-07-08",
		},
		labelBudget: {
			value: 40,
			provenance: "provisional",
			source: "starting budget",
		},
	},
	drawer: {
		maxNodes: {
			value: 300,
			provenance: "provisional",
			source: "existing drawer budget — re-verify",
		},
		labelBudget: {
			value: 80,
			provenance: "measured",
			source: "label level-of-detail research budget",
			measuredAt: "2026-06-20",
		},
	},
	panel: {
		maxNodes: {
			value: 2000,
			provenance: "measured",
			source:
				"benchmark: canvas comfortable to ~1–2k (31fps @2k); a ~500-node WebGL threshold is directionally right",
			measuredAt: "2026-07-15",
		},
		labelBudget: {
			value: 120,
			provenance: "measured",
			source: "label level-of-detail research budget",
			measuredAt: "2026-06-20",
		},
	},
	workbench: {
		maxNodes: {
			value: 10_000,
			provenance: "measured",
			source: "benchmark: clean 60/60fps @10k on a WebGL renderer",
			measuredAt: "2026-07-15",
		},
		labelBudget: {
			value: 200,
			provenance: "measured",
			source: "benchmark: a top-200 overlay is ≈ free over a WebGL cloud",
			measuredAt: "2026-07-15",
		},
	},
	atlas: {
		maxNodes: {
			value: 50_000,
			provenance: "measured",
			source:
				"benchmark: 50k idle at 55.5fps with free layout + precomputed positions (high-end device ceiling — a device-adaptive cap is recommended)",
			measuredAt: "2026-07-15",
		},
		labelBudget: {
			value: 200,
			provenance: "measured",
			source: "benchmark label-overlay cells",
			measuredAt: "2026-07-15",
		},
	},
};
