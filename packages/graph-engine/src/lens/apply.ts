/**
 * Lens runtime primitives.
 *
 * Styling is computed as per-node PATCHES and diffed — a lens/filter toggle
 * re-pushes only the nodes whose style actually changed, never the whole
 * graph (a naive implementation would re-run an O(N+E) restyle + full
 * re-push per toggle).
 */

import type {
	GraphNodeV1,
	GraphRef,
	Provenance,
	StyleRule,
} from "@fxyz/graph-contract";

export interface StylePatch {
	color?: string;
	size?: number;
	brightness?: number;
	edgeClass?: string;
	shape?: string;
	/** Provenance rendering: illustrative data is visually distinct. */
	dashed?: boolean;
	provenanceBadge?: Provenance;
}

/**
 * Provenance is a visual primitive: dashed = illustrative, solid = real;
 * stale/unmeasured carry their badge.
 */
export function provenanceVisual(provenance: Provenance): StylePatch {
	return {
		dashed: provenance === "illustrative",
		provenanceBadge: provenance,
	};
}

function readSource(
	node: GraphNodeV1,
	source: StyleRule["source"],
): number | undefined {
	if (source.startsWith("prop:")) return undefined; // property channel is not yet wired for numeric reads
	const value =
		node.measures?.[source as keyof NonNullable<typeof node.measures>];
	return typeof value === "number" ? value : undefined;
}

/** Area-true size: radius ∝ √value, clamped to a usable band. */
export function sizeFromValue(value: number, min = 6, max = 48): number {
	if (!Number.isFinite(value) || value <= 0) return min;
	return Math.min(max, Math.max(min, Math.round(2 * Math.sqrt(value))));
}

/**
 * Categorical community palette: five base hues plus
 * five derived shades (10 total) — concrete hex, so the backend colour boundary
 * passes them straight through (no CSS-var resolution needed). Community
 * membership is nominal, not ordinal, so the mapping is a stable hash, never a
 * ramp: the same community ref always lands on the same hue across sessions and
 * reloads, and distinct refs spread across the wheel.
 */
export const COMMUNITY_PALETTE = [
	"#fbbc7a", // amber
	"#e87044", // orange
	"#64be25", // green
	"#aec2f8", // periwinkle
	"#5c7ad3", // blue
	"#c8894a", // amber, darker
	"#f4a07f", // orange, lighter
	"#3f7d17", // green, darker
	"#7f97d0", // periwinkle, darker
	"#8fa6e6", // blue, lighter
] as const;

/**
 * FNV-1a over the community ref, folded to 32 bits — deterministic and
 * dependency-free. `Math.imul` keeps it in the 32-bit integer domain so the
 * result is identical everywhere (no float drift, no session salt).
 */
function hashCommunityRef(ref: string): number {
	let h = 2166136261;
	for (let i = 0; i < ref.length; i += 1) {
		h ^= ref.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Stable community ref → palette hue. */
export function communityColor(ref: string): string {
	return COMMUNITY_PALETTE[hashCommunityRef(ref) % COMMUNITY_PALETTE.length];
}

export function applyStyleRules(
	nodes: GraphNodeV1[],
	rules: StyleRule[],
): Map<GraphRef, StylePatch> {
	const patches = new Map<GraphRef, StylePatch>();
	for (const node of nodes) {
		const patch: StylePatch = provenanceVisual(node.provenance);
		for (const rule of rules) {
			if (rule.channel === "color") {
				// Categorical community coloring: a node's
				// version-qualified community ref maps deterministically to a
				// concrete palette hue. Nodes with NO community keep whatever the
				// lens default left (an earlier role rule, else bare) — never
				// forced onto the palette.
				if (rule.source === "community") {
					if (node.community) patch.color = communityColor(node.community);
					continue;
				}
				// Color never reads a numeric source. `prop:roles` binds each
				// node's OWN first data role; a rule-level `role` paints the
				// lens's whole node set. Either way the patch carries a
				// `var(--fx-role-*)` token — the backend boundary resolves it
				// to a concrete color (canvas/WebGL can't parse CSS vars).
				const role =
					rule.source === "prop:roles" ? node.roles?.[0] : rule.role;
				if (role) patch.color = `var(--fx-role-${role})`;
				continue;
			}
			const value = readSource(node, rule.source);
			if (value === undefined) continue;
			// Size is area-true (radius ∝ √value — the standard magnitude
			// encoding; a raw count as pixel radius would make a 5k-member
			// community fill the viewport), clamped to the renderer's usable
			// node-radius band.
			if (rule.channel === "size") patch.size = sizeFromValue(value);
			if (rule.channel === "brightness") patch.brightness = value;
		}
		patches.set(node.id, patch);
	}
	return patches;
}

/**
 * Incremental delta: which refs actually changed between two patch maps.
 * The backend re-push is bounded by THIS set, not by N.
 */
export function diffStylePatches(
	prev: Map<GraphRef, StylePatch>,
	next: Map<GraphRef, StylePatch>,
): GraphRef[] {
	const changed: GraphRef[] = [];
	for (const [ref, patch] of next) {
		const before = prev.get(ref);
		if (!before || JSON.stringify(before) !== JSON.stringify(patch)) {
			changed.push(ref);
		}
	}
	for (const ref of prev.keys()) {
		if (!next.has(ref)) changed.push(ref);
	}
	return changed;
}
