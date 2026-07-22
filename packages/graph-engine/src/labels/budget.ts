/**
 * Budgeted labels: labels are OUR overlay — the renderer's WebGL path
 * renders no captions, and on the canvas tier
 * the engine deliberately leaves native captions untriggered (passes `label`,
 * never `caption`) so there is exactly ONE label system. Per-frame
 * label count is bounded by the lens budget, independent of graph size.
 */

import type { GraphNodeV1, MeasureKind } from "@fxyz/graph-contract";

/**
 * Deterministic top-N selection. Rank measure comes from the lens
 * (labelRankMeasure — e.g. "count" for community-summary tiers, so the
 * biggest communities carry labels); default is degree-first with magnitude
 * fallback. Ref is the final tiebreak (stable across identical payloads).
 *
 * Named-first: when a payload
 * declares label quality, REAL names outrank synthesized fallbacks at any
 * measure — a wall of generic labels like "Cluster 12" must never crowd
 * exemplar-named communities out of the budget. Within the generic pool,
 * identical label text renders at most twice (the third copy adds noise,
 * not information). Payloads without labelQuality are untouched (every node
 * ranks as named).
 */
export function pickLabeledNodes(
	nodes: GraphNodeV1[],
	budget: number,
	rankMeasure?: MeasureKind,
): GraphNodeV1[] {
	if (budget <= 0) return [];
	const score = (n: GraphNodeV1): number => {
		if (rankMeasure !== undefined) {
			const ranked = n.measures?.[rankMeasure];
			if (ranked !== undefined) return ranked as number;
		}
		return n.measures?.degree ?? n.measures?.magnitude ?? 0;
	};
	const sorted = [...nodes].sort((a, b) => {
		const d = score(b) - score(a);
		if (d !== 0) return d;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	const named: GraphNodeV1[] = [];
	const generic: GraphNodeV1[] = [];
	for (const n of sorted) {
		(n.labelQuality === "generic" ? generic : named).push(n);
	}
	const picked = named;
	const genericTextSeen = new Map<string, number>();
	for (const n of generic) {
		const seen = genericTextSeen.get(n.label) ?? 0;
		if (seen >= 2) continue;
		genericTextSeen.set(n.label, seen + 1);
		picked.push(n);
	}
	return picked.slice(0, budget);
}
