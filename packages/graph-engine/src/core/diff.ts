/**
 * The salvaged nucleus (NVL-UNDERUSE-AUDIT §4 "keep-as-law → extract"):
 * incremental diff/apply ported from
 * `packages/visualization/src/hooks/useNVLInstance.ts:181-222` — the ONE
 * piece of the 2024 adapter verified sound. Lineage preserved:
 *
 * - Ids are String-coerced on BOTH sides so a number/string drift between a
 *   backend's stored ids and pipeline ids can never silently skip a removal —
 *   the #791 accumulation class ("adds new nodes, never removes absent ones").
 * - Remove-then-add is the single source of truth for updates; re-applying
 *   identical data is a no-op removal + idempotent upsert (engine law 8:
 *   incremental only, a data change never reconstructs the instance).
 */

import type {
	BackendNode,
	BackendRel,
	GraphBackend,
} from "../backend/contract";

export function computeElementDiff(
	currentNodes: { id: string | number }[],
	currentRels: { id: string | number }[],
	newNodes: { id: string | number }[],
	newRels: { id: string | number }[],
): { removedNodeIds: string[]; removedRelIds: string[] } {
	const newNodeIds = new Set(newNodes.map((n) => String(n.id)));
	const newRelIds = new Set(newRels.map((r) => String(r.id)));
	const removedNodeIds = currentNodes.flatMap((n) =>
		newNodeIds.has(String(n.id)) ? [] : [String(n.id)],
	);
	const removedRelIds = currentRels.flatMap((r) =>
		newRelIds.has(String(r.id)) ? [] : [String(r.id)],
	);
	return { removedNodeIds, removedRelIds };
}

export function applyDataUpdate(
	backend: GraphBackend,
	newNodes: BackendNode[],
	newRels: BackendRel[],
): void {
	const { removedNodeIds, removedRelIds } = computeElementDiff(
		backend.getNodes(),
		backend.getRelationships(),
		newNodes,
		newRels,
	);
	if (removedRelIds.length > 0) {
		backend.removeRelationshipsWithIds(removedRelIds);
	}
	if (removedNodeIds.length > 0) {
		backend.removeNodesWithIds(removedNodeIds);
	}
	backend.addAndUpdateElementsInGraph(newNodes, newRels);
}
