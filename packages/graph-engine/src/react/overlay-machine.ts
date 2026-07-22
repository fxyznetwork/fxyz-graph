/**
 * The two-state overlay contract as a PURE machine.
 *
 * Preview  — pointer-events constrained, zoom off, the pane never captures
 *            page scroll. The FIRST tap activates only: it is consumed (no
 *            selection, no navigation) and must produce a visible state
 *            change.
 * Active   — full interaction, explicit visible exit affordance; Esc /
 *            outside-click / IntersectionObserver exit return to Preview.
 *
 * Full-page surfaces (workbench / atlas presets) have NO Preview state: they
 * are born Active and exit events are ignored.
 *
 * Kept renderer-free and React-free so the contract is independently
 * testable.
 */

import type { Tier } from "@fxyz/graph-contract";

export type OverlayState = "preview" | "active";

export type OverlayEvent =
	| "tap"
	| "esc"
	| "outside-pointer"
	| "exit-affordance"
	| "viewport-exit";

export interface OverlayDecision {
	state: OverlayState;
	/**
	 * True when the overlay consumed the event — the activation tap NEVER
	 * doubles as select/navigate (the activation tap and the inspect tap are
	 * never the same event).
	 */
	consumed: boolean;
}

/** Full-page presets have no Preview state. */
export function isFullPagePreset(preset: Tier): boolean {
	return preset === "workbench" || preset === "atlas";
}

export function initialOverlayState(preset: Tier): OverlayState {
	return isFullPagePreset(preset) ? "active" : "preview";
}

export function overlayReduce(
	state: OverlayState,
	event: OverlayEvent,
	opts: { fullPage: boolean },
): OverlayDecision {
	if (opts.fullPage) {
		// Born active, stays active; nothing is consumed by the overlay.
		return { state: "active", consumed: false };
	}
	if (state === "preview") {
		if (event === "tap") {
			return { state: "active", consumed: true };
		}
		// Exit-class events are no-ops in preview.
		return { state: "preview", consumed: false };
	}
	// state === "active"
	if (
		event === "esc" ||
		event === "outside-pointer" ||
		event === "exit-affordance" ||
		event === "viewport-exit"
	) {
		return { state: "preview", consumed: true };
	}
	// Taps in active flow through to the one-tap law (inspect / navigate).
	return { state: "active", consumed: false };
}
