/**
 * pane-trace (tm #1136 diagnostic): OFF by default, armed via ?paneTrace=1 or
 * the sticky localStorage flag, ring-capped, phase crumbs land even when the
 * traced body throws. Node env — window is faked per test.
 */

import { createPaneTracer, readPaneTrace } from "../react/pane-trace";

type Store = Map<string, string>;

function fakeWindow(search: string, store: Store) {
	return {
		location: { search },
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => {
				store.set(k, v);
			},
			removeItem: (k: string) => {
				store.delete(k);
			},
		},
	};
}

function setFakeWindow(win: ReturnType<typeof fakeWindow>): void {
	(globalThis as { window?: unknown }).window = win;
}

afterEach(() => {
	// biome-ignore lint/performance/noDelete: test global cleanup
	delete (globalThis as { window?: unknown }).window;
});

function ring(store: Store): string[] {
	const raw = store.get("fx.paneTrace.bc");
	return raw ? (JSON.parse(raw) as string[]) : [];
}

describe("pane-trace (#1136 forensics)", () => {
	it("is a no-op by default — no flag, no writes, enabled=false", () => {
		const store: Store = new Map();
		setFakeWindow(fakeWindow("", store));
		const tr = createPaneTracer();
		expect(tr.enabled).toBe(false);
		tr.crumb("should never land");
		tr.phase("p")();
		expect(store.size).toBe(0);
	});

	it("is a no-op under SSR (no window)", () => {
		expect(createPaneTracer().enabled).toBe(false);
	});

	it("?paneTrace=1 arms the tracer AND sets the sticky flag", () => {
		const store: Store = new Map();
		setFakeWindow(fakeWindow("?paneTrace=1", store));
		const tr = createPaneTracer();
		expect(tr.enabled).toBe(true);
		expect(store.get("fx.paneTrace")).toBe("1");
		tr.crumb("tap landed");
		expect(ring(store).some((l) => l.includes("tap landed"))).toBe(true);
	});

	it("sticky flag alone (no query param) arms later mounts", () => {
		const store: Store = new Map([["fx.paneTrace", "1"]]);
		setFakeWindow(fakeWindow("", store));
		expect(createPaneTracer().enabled).toBe(true);
	});

	it("phase() crumbs entry and a duration exit — even when the body throws", () => {
		const store: Store = new Map([["fx.paneTrace", "1"]]);
		setFakeWindow(fakeWindow("", store));
		const tr = createPaneTracer();
		const end = tr.phase("up tap 12,34");
		try {
			throw new Error("handler exploded");
		} catch {
			end();
		}
		const lines = ring(store);
		expect(lines.some((l) => l.includes(">up tap 12,34"))).toBe(true);
		expect(lines.some((l) => /<up tap 12,34 \d+(\.\d+)?ms/.test(l))).toBe(true);
	});

	it("ring caps at 400 crumbs (oldest dropped, storage bounded)", () => {
		const store: Store = new Map([["fx.paneTrace", "1"]]);
		setFakeWindow(fakeWindow("", store));
		const tr = createPaneTracer();
		for (let i = 0; i < 450; i += 1) tr.crumb(`c${i}`);
		const lines = ring(store);
		expect(lines.length).toBeLessThanOrEqual(400);
		expect(lines[lines.length - 1]).toContain("c449");
		expect(lines.some((l) => l.includes("c0 "))).toBe(false);
	});

	it("readPaneTrace returns the prior run's ring (post-freeze forensics)", () => {
		const store: Store = new Map([["fx.paneTrace", "1"]]);
		setFakeWindow(fakeWindow("", store));
		const tr = createPaneTracer();
		tr.crumb("last thing before the freeze");
		const recovered = readPaneTrace();
		expect(
			recovered.some((l) => l.includes("last thing before the freeze")),
		).toBe(true);
	});
});
