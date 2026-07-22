/**
 * Pointer-gesture classifier for the one-tap law (engine law 2 / REPORT §5):
 * tap = inspect · double-tap = navigate · drag = pan. HOVER IS A BANNED
 * CLASS on graph canvases (founder-tested, killed twice) — this module has
 * no hover concept on purpose.
 *
 * NVL ships ZERO touch events in any version (mechanics bank), so pointer
 * handling is hand-wired at the pane layer; this classifier is the shared,
 * clock-injectable core so the law is testable without a DOM.
 *
 * Double-tap semantics: the first tap fires immediately (inspect stays
 * snappy — no 300ms hold-back); a second tap within the window ALSO fires
 * as `double` (navigate). Inspect-then-navigate is the accepted sequence.
 */

export type TapOutcome = "tap" | "double" | "drag" | null;

export interface TapClassifierOptions {
	/** Movement beyond this (px) turns the gesture into a drag. */
	slopPx?: number;
	/** Max press duration (ms) for a tap; longer is a drag/hold. */
	maxTapMs?: number;
	/** Two taps within this window (ms) and slop*2 radius = double. */
	doubleMs?: number;
	/** Injectable clock for deterministic tests. */
	now?: () => number;
}

export class TapClassifier {
	private readonly slopPx: number;
	private readonly maxTapMs: number;
	private readonly doubleMs: number;
	private readonly now: () => number;

	private downAt: { x: number; y: number; t: number } | null = null;
	private dragging = false;
	private lastTap: { x: number; y: number; t: number } | null = null;

	constructor(opts: TapClassifierOptions = {}) {
		this.slopPx = opts.slopPx ?? 8;
		this.maxTapMs = opts.maxTapMs ?? 500;
		this.doubleMs = opts.doubleMs ?? 300;
		this.now = opts.now ?? (() => Date.now());
	}

	down(x: number, y: number): void {
		this.downAt = { x, y, t: this.now() };
		this.dragging = false;
	}

	/** True from the moment slop is exceeded until the pointer lifts. */
	isDragging(): boolean {
		return this.dragging;
	}

	/** Returns "drag" the moment slop is exceeded (pan starts), else null. */
	move(x: number, y: number): "drag" | null {
		if (!this.downAt || this.dragging) return this.dragging ? "drag" : null;
		const dx = x - this.downAt.x;
		const dy = y - this.downAt.y;
		if (dx * dx + dy * dy > this.slopPx * this.slopPx) {
			this.dragging = true;
			return "drag";
		}
		return null;
	}

	up(x: number, y: number): TapOutcome {
		const down = this.downAt;
		this.downAt = null;
		if (!down) return null;
		if (this.dragging) {
			this.dragging = false;
			return "drag";
		}
		const t = this.now();
		if (t - down.t > this.maxTapMs) return null;

		const prev = this.lastTap;
		if (
			prev &&
			t - prev.t <= this.doubleMs &&
			(x - prev.x) ** 2 + (y - prev.y) ** 2 <= (this.slopPx * 2) ** 2
		) {
			this.lastTap = null; // a triple never chains two doubles
			return "double";
		}
		this.lastTap = { x, y, t };
		return "tap";
	}

	cancel(): void {
		this.downAt = null;
		this.dragging = false;
	}
}
