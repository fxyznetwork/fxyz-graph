/**
 * Settle-policy behavior — pure machine, no DOM (house pattern). The
 * bounded-settle contract: deadline adoption on a jittering sim,
 * exactly one onSettled, one final correcting adoption at true quiescence.
 */

import {
	SETTLE_DEADLINE_MS,
	settleStep,
} from "../react/settle-policy";

describe("settle policy (bounded settle)", () => {
	it("free layouts never adopt — they fire once at first non-moving observation and stop", () => {
		const action = settleStep({
			isSim: false,
			moving: false,
			adopted: false,
			elapsedMs: 16,
		});
		expect(action).toEqual({ adopt: false, fireOnSettled: true, done: true });
	});

	it("a sim that quiesces before the deadline adopts + fires + stops in one step", () => {
		// moving frames before quiescence do nothing
		expect(
			settleStep({ isSim: true, moving: true, adopted: false, elapsedMs: 500 }),
		).toEqual({ adopt: false, fireOnSettled: false, done: false });
		// quiescence
		expect(
			settleStep({
				isSim: true,
				moving: false,
				adopted: false,
				elapsedMs: 2_100,
			}),
		).toEqual({ adopt: true, fireOnSettled: true, done: true });
	});

	it("a sim still moving at the deadline adopts + fires but KEEPS POLLING", () => {
		const action = settleStep({
			isSim: true,
			moving: true,
			adopted: false,
			elapsedMs: SETTLE_DEADLINE_MS,
		});
		expect(action).toEqual({ adopt: true, fireOnSettled: true, done: false });
	});

	it("after a deadline adoption, moving frames stay silent (no repeat fire/adopt)", () => {
		const action = settleStep({
			isSim: true,
			moving: true,
			adopted: true,
			elapsedMs: SETTLE_DEADLINE_MS + 30_000,
		});
		expect(action).toEqual({ adopt: false, fireOnSettled: false, done: false });
	});

	it("true quiescence after a deadline adoption re-adopts (final correction) without a second onSettled", () => {
		const action = settleStep({
			isSim: true,
			moving: false,
			adopted: true,
			elapsedMs: 95_600,
		});
		expect(action).toEqual({ adopt: true, fireOnSettled: false, done: true });
	});

	it("the deadline never triggers for free layouts even if the backend reports motion", () => {
		const action = settleStep({
			isSim: false,
			moving: true,
			adopted: false,
			elapsedMs: SETTLE_DEADLINE_MS * 2,
		});
		expect(action).toEqual({ adopt: false, fireOnSettled: false, done: false });
	});
});
