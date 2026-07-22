/**
 * Settle policy (#1072) — pure decision machine for the GraphPane settle
 * watcher. NVL's bundled d3Force runs with alphaDecay 0, so ε-quiescence
 * (10 stable rAF samples @ 0.01 world units, backend/nvl.ts) can trail the
 * macro-layout by ~90s of micro-jitter (prod correlation 29/281 observed
 * 95.6s, 2026-07-17). The macro structure converges in ~1-3s — waiting the
 * full jitter tail out kept labels, the settled hit-index, and the camera
 * re-sync hostage.
 *
 * Two-phase contract:
 *  - DEADLINE ADOPTION: past SETTLE_DEADLINE_MS on a still-moving sim, adopt
 *    the current positions once (labels/hit-index/camera go live, onSettled
 *    fires with the bounded time) and KEEP POLLING.
 *  - TRUE QUIESCENCE: whenever the backend reports motion stopped, (re-)adopt
 *    — after a deadline adoption this lands one final position correction —
 *    and stop. onSettled never fires twice.
 *
 * `free` layouts are born settled (payload positions are render truth): no
 * adoption, onSettled reports at first non-moving observation, stop.
 */

export const SETTLE_DEADLINE_MS = 8_000;

export interface SettleInput {
	/** Client-sim mount (layout !== "free"). */
	isSim: boolean;
	/** Backend motion oracle for this frame (isLayoutMoving()). */
	moving: boolean;
	/** A deadline adoption already happened for this ingest. */
	adopted: boolean;
	/** ms since the watcher started for this ingest. */
	elapsedMs: number;
}

export interface SettleAction {
	/** Adopt current backend positions (labels + hit-index + camera sync). */
	adopt: boolean;
	/** Fire onSettled(elapsedMs) — at most once per ingest. */
	fireOnSettled: boolean;
	/** Stop polling. */
	done: boolean;
}

export function settleStep(input: SettleInput): SettleAction {
	if (!input.moving) {
		return {
			adopt: input.isSim,
			fireOnSettled: !input.adopted,
			done: true,
		};
	}
	if (input.isSim && !input.adopted && input.elapsedMs >= SETTLE_DEADLINE_MS) {
		return { adopt: true, fireOnSettled: true, done: false };
	}
	return { adopt: false, fireOnSettled: false, done: false };
}
