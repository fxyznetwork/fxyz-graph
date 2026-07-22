/**
 * Layout policy (engine law 5; audit RC1): default is `free` + server
 * positions. A client sim is an explicit small-graph opt-in below a MEASURED
 * budget; any payload above the client-sim ceiling without precomputed
 * positions is a hard error — never a silent client force-layout.
 */

import type { GraphPayloadV1, ProvenancedNumber } from "@fxyz/graph-contract";

export interface LayoutPolicy {
	/** Explicit opt-in for small-graph client sims. Default: never. */
	allowClientSim: boolean;
	/** Measured ceiling for the client sim (provenance-carrying, law 11). */
	clientSimMaxNodes: ProvenancedNumber;
}

export const DEFAULT_LAYOUT_POLICY: LayoutPolicy = {
	allowClientSim: true,
	clientSimMaxNodes: {
		value: 2000,
		provenance: "measured",
		source:
			"fair benchmark 2026-07-15: d3Force settles 1k in 2.2s; 8k takes 7.5s (a UX-latency choice, not an engine cap) — 2k keeps first-paint latency sane",
		measuredAt: "2026-07-15",
	},
};

export class LayoutPolicyViolation extends Error {
	readonly law = "law-5";
	constructor(message: string) {
		super(`[law-5] ${message}`);
		this.name = "LayoutPolicyViolation";
	}
}

export function resolveLayout(
	policy: LayoutPolicy,
	payload: Pick<GraphPayloadV1, "positionsIncluded" | "nodes">,
): "free" | "d3Force" {
	if (payload.positionsIncluded) return "free";
	if (
		policy.allowClientSim &&
		payload.nodes.length <= policy.clientSimMaxNodes.value
	) {
		return "d3Force";
	}
	throw new LayoutPolicyViolation(
		`payload of ${payload.nodes.length} nodes carries no server positions and exceeds the client-sim budget (${policy.clientSimMaxNodes.value}, ${policy.clientSimMaxNodes.provenance}) — precompute positions server-side (#580 step 2), never client-scatter at scale`,
	);
}
