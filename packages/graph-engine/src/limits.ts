/**
 * Limits are CONSUMED from graph-layout, never forked (engine law 2 + the
 * audit's keep-as-law verdict): the allowlist, tier caps, and degree budgets
 * are the only incident-backed numbers in the stack.
 */

export {
	getPublicGraphFullMaxNodes,
	getPublicGraphTierLimit,
	PUBLIC_GRAPH_PUBLIC_LABELS,
	PUBLIC_GRAPH_SENSITIVE_LABELS,
	type PublicGraphPublicLabel,
	type PublicGraphSensitiveLabel,
	type PublicGraphTier,
	resolvePublicGraphLimit,
} from "@fxyz/graph-layout/public-graph-limits";
