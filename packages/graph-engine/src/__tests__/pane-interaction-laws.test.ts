/**
 * GraphPane interaction behavior as contract tests.
 * Pure machines — no DOM, no renderer: the behavior holds independent of backend.
 */

import type { GraphNodeV1, Tier } from "@fxyz/graph-contract";
import {
	initialOverlayState,
	isFullPagePreset,
	overlayReduce,
} from "../react/overlay-machine";
import { TapClassifier } from "../react/tap-classifier";
import {
	NodeHitIndex,
	panByScreenDelta,
	screenToWorld,
	worldToScreen,
	zoomAround,
} from "../react/view";

describe("two-state overlay contract", () => {
	it("embedded panes are born Preview; full-page presets are born Active", () => {
		const embedded: Tier[] = ["peek", "chip", "tile", "drawer", "panel"];
		for (const preset of embedded) {
			expect(initialOverlayState(preset)).toBe("preview");
			expect(isFullPagePreset(preset)).toBe(false);
		}
		expect(initialOverlayState("workbench")).toBe("active");
		expect(initialOverlayState("atlas")).toBe("active");
	});

	it("the activation tap is CONSUMED — never a select/navigate", () => {
		const d = overlayReduce("preview", "tap", { fullPage: false });
		expect(d.state).toBe("active");
		expect(d.consumed).toBe(true);
	});

	it("taps while Active flow through to the one-tap law", () => {
		const d = overlayReduce("active", "tap", { fullPage: false });
		expect(d.state).toBe("active");
		expect(d.consumed).toBe(false);
	});

	it("Esc / outside / exit-affordance / viewport-exit all return to Preview", () => {
		for (const event of [
			"esc",
			"outside-pointer",
			"exit-affordance",
			"viewport-exit",
		] as const) {
			const d = overlayReduce("active", event, { fullPage: false });
			expect(d.state).toBe("preview");
		}
	});

	it("exit-class events are no-ops in Preview", () => {
		for (const event of ["esc", "outside-pointer", "viewport-exit"] as const) {
			const d = overlayReduce("preview", event, { fullPage: false });
			expect(d.state).toBe("preview");
			expect(d.consumed).toBe(false);
		}
	});

	it("full-page surfaces have NO Preview state — exits are ignored", () => {
		for (const event of [
			"esc",
			"outside-pointer",
			"viewport-exit",
			"tap",
		] as const) {
			const d = overlayReduce("active", event, { fullPage: true });
			expect(d.state).toBe("active");
			expect(d.consumed).toBe(false);
		}
	});
});

describe("one-tap gesture classifier (hover is a banned class)", () => {
	const mkClock = () => {
		let t = 0;
		return { now: () => t, tick: (ms: number) => (t += ms) };
	};

	it("down→up within slop and time = tap", () => {
		const clock = mkClock();
		const c = new TapClassifier({ now: clock.now });
		c.down(100, 100);
		clock.tick(120);
		expect(c.up(103, 101)).toBe("tap");
	});

	it("two taps within the window = double (navigate)", () => {
		const clock = mkClock();
		const c = new TapClassifier({ now: clock.now });
		c.down(100, 100);
		clock.tick(80);
		expect(c.up(100, 100)).toBe("tap");
		clock.tick(150);
		c.down(102, 99);
		clock.tick(60);
		expect(c.up(102, 99)).toBe("double");
	});

	it("a third tap never chains a second double", () => {
		const clock = mkClock();
		const c = new TapClassifier({ now: clock.now });
		c.down(0, 0);
		expect(c.up(0, 0)).toBe("tap");
		clock.tick(100);
		c.down(0, 0);
		expect(c.up(0, 0)).toBe("double");
		clock.tick(100);
		c.down(0, 0);
		expect(c.up(0, 0)).toBe("tap");
	});

	it("movement past slop = drag (pan), never a tap on release", () => {
		const clock = mkClock();
		const c = new TapClassifier({ now: clock.now });
		c.down(100, 100);
		expect(c.move(104, 100)).toBeNull(); // within slop
		expect(c.isDragging()).toBe(false);
		expect(c.move(120, 100)).toBe("drag");
		expect(c.isDragging()).toBe(true);
		expect(c.up(140, 100)).toBe("drag");
	});

	it("a long press is not a tap", () => {
		const clock = mkClock();
		const c = new TapClassifier({ now: clock.now });
		c.down(50, 50);
		clock.tick(900);
		expect(c.up(50, 50)).toBeNull();
	});

	it("taps far apart in space are two singles, not a double", () => {
		const clock = mkClock();
		const c = new TapClassifier({ now: clock.now });
		c.down(0, 0);
		expect(c.up(0, 0)).toBe("tap");
		clock.tick(100);
		c.down(200, 200);
		expect(c.up(200, 200)).toBe("tap");
	});
});

describe("view math + tap-time hit-testing", () => {
	// The renderer's bundle-verified transform: center-origin,
	// subtractive pan, css scale = zoom/dpr.
	const baseView = {
		scale: 2,
		panX: 40,
		panY: -12,
		width: 800,
		height: 600,
		dpr: 2,
	};

	it("worldToScreen matches the renderer model", () => {
		// css_x = (scale/dpr)·(x − panX) + width/2 = 1·(10−40) + 400 = 370
		const p = worldToScreen(baseView, 10, -3);
		expect(p.x).toBeCloseTo(370);
		expect(p.y).toBeCloseTo(1 * (-3 - -12) + 300);
	});

	it("worldToScreen/screenToWorld round-trip", () => {
		const p = worldToScreen(baseView, 10, -3);
		const back = screenToWorld(baseView, p.x, p.y);
		expect(back.x).toBeCloseTo(10);
		expect(back.y).toBeCloseTo(-3);
	});

	it("zoomAround keeps the world point under the anchor fixed", () => {
		const anchor = { x: 120, y: 80 };
		const before = screenToWorld(baseView, anchor.x, anchor.y);
		const zoomed = zoomAround(baseView, anchor.x, anchor.y, 1.7);
		const after = screenToWorld(zoomed, anchor.x, anchor.y);
		expect(after.x).toBeCloseTo(before.x);
		expect(after.y).toBeCloseTo(before.y);
	});

	it("panByScreenDelta drags the graph with the pointer", () => {
		// A world point at screen (370, 309) dragged +50css right must land
		// at (420, 309): pan is subtractive, so panX decreases.
		const worldBefore = screenToWorld(baseView, 370, 309);
		const panned = panByScreenDelta(baseView, 50, 0);
		const after = worldToScreen(panned, worldBefore.x, worldBefore.y);
		expect(after.x).toBeCloseTo(420);
		expect(after.y).toBeCloseTo(309);
	});

	it("hit-testing resolves the nearest node within the screen radius", () => {
		const nodes: GraphNodeV1[] = [
			{
				id: "currency:USD",
				kind: "currency",
				label: "USD",
				x: 0,
				y: 0,
				provenance: "real",
			},
			{
				id: "currency:EUR",
				kind: "currency",
				label: "EUR",
				x: 30,
				y: 0,
				provenance: "real",
			},
		] as GraphNodeV1[];
		const index = new NodeHitIndex(nodes);
		const view = { scale: 1, panX: 0, panY: 0, width: 0, height: 0, dpr: 1 };
		// center-origin with width/height 0 → screen == world here
		expect(index.hit(view, 4, 2)?.id).toBe("currency:USD");
		expect(index.hit(view, 28, -2)?.id).toBe("currency:EUR");
		expect(index.hit(view, 300, 300)).toBeNull();
	});

	it("nodes without positions never enter the index (no NaN cells)", () => {
		const nodes = [
			{ id: "concept:a", kind: "concept", label: "A", provenance: "real" },
		] as GraphNodeV1[];
		const index = new NodeHitIndex(nodes);
		expect(index.size).toBe(0);
	});
});
