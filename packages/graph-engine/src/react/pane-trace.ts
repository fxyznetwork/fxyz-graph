/**
 * Freeze-surviving interaction trace, a diagnostic instrument.
 *
 * A workbench "renderer freeze" could not be reproduced against a large
 * edge-count scene in an isolated harness (every tap fast, renderer patch
 * cost flat) — the hang lives somewhere in the surrounding environment, and
 * the only way to catch it under real usage is evidence that OUTLIVES a dead
 * tab. This tracer writes a small breadcrumb ring to localStorage synchronously;
 * after a freeze + reload, the last crumb names the phase that never
 * finished.
 *
 * OFF by default — zero writes, one boolean check per event. Enabled per
 * member/tab via `?paneTrace=1` (sticky for the session through
 * `localStorage["fx.paneTrace"]="1"`; remove the key to disarm).
 */

const FLAG_KEY = "fx.paneTrace";
const RING_KEY = "fx.paneTrace.bc";
const RING_MAX = 400;

export interface PaneTracer {
	readonly enabled: boolean;
	/** Append one breadcrumb (no-op when disabled). */
	crumb(line: string): void;
	/**
	 * Time a phase: returns a closer that crumbs `<name> Xms` (call in a
	 * `finally` so the crumb lands even when the phase throws).
	 */
	phase(name: string): () => void;
}

const NOOP_TRACER: PaneTracer = {
	enabled: false,
	crumb: () => {},
	phase: () => () => {},
};

/** The previous run's ring (post-freeze reload forensics). */
export function readPaneTrace(): string[] {
	try {
		const raw = window.localStorage.getItem(RING_KEY);
		return raw ? (JSON.parse(raw) as string[]) : [];
	} catch {
		return [];
	}
}

export function createPaneTracer(): PaneTracer {
	if (typeof window === "undefined") return NOOP_TRACER;
	let enabled = false;
	try {
		if (new URLSearchParams(window.location.search).has("paneTrace")) {
			window.localStorage.setItem(FLAG_KEY, "1");
			enabled = true;
		} else {
			enabled = window.localStorage.getItem(FLAG_KEY) === "1";
		}
	} catch {
		return NOOP_TRACER; // storage denied → tracing impossible, stay silent
	}
	if (!enabled) return NOOP_TRACER;

	const ring: string[] = readPaneTrace();
	const crumb = (line: string): void => {
		ring.push(`${performance.now().toFixed(1)} ${line}`);
		if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
		try {
			window.localStorage.setItem(RING_KEY, JSON.stringify(ring));
		} catch {
			/* quota — keep the in-memory ring going */
		}
	};
	crumb(`--- pane-trace armed ${new Date().toISOString()}`);
	return {
		enabled: true,
		crumb,
		phase(name: string): () => void {
			const t0 = performance.now();
			crumb(`>${name}`);
			return () => crumb(`<${name} ${(performance.now() - t0).toFixed(1)}ms`);
		},
	};
}
