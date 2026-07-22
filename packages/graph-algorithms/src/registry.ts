/**
 * The algorithm registry + the grounding guard.
 *
 * Registering an algorithm is how you add an analytic — there is no per-page
 * pipeline. The guard makes operator-hud-grounding a BOOT-TIME invariant: a
 * ƒxyz-coined metric (one carrying a `groundingConceptId`) cannot register
 * unless its :Concept is active. This kills the ungrounded-R0 / circle-
 * temperature class of defect structurally, instead of relying on a reviewer
 * to catch it.
 *
 * The grounding check is INJECTED (a `GroundingChecker`) rather than querying
 * the graph here, so this package stays pure/dependency-light. At app boot the
 * checker is wired to the live canon; in tests it is a stub.
 */

import type { Algorithm, AlgorithmFamily } from "./types";

/** Returns true iff the given :Concept id is active canon. */
export type GroundingChecker = (conceptId: string) => boolean;

/** Thrown when a coined metric registers without active-canon grounding. */
export class GroundingError extends Error {
	constructor(
		public readonly algorithmId: string,
		public readonly conceptId: string,
	) {
		super(
			`Algorithm "${algorithmId}" declares groundingConceptId "${conceptId}" ` +
				`but that :Concept is not active canon (or no GroundingChecker was ` +
				`provided). Per operator-hud-grounding, a ƒxyz-coined metric must be ` +
				`grounded by an active :Concept before it can register.`,
		);
		this.name = "GroundingError";
	}
}

/** Thrown when two algorithms register under the same id. */
export class DuplicateAlgorithmError extends Error {
	constructor(public readonly algorithmId: string) {
		super(`Algorithm "${algorithmId}" is already registered.`);
		this.name = "DuplicateAlgorithmError";
	}
}

export interface RegistryOptions {
	/**
	 * Verifies coined-metric grounding. When omitted, ANY algorithm carrying a
	 * `groundingConceptId` fails to register (fail-closed) — a published
	 * algorithm with no `groundingConceptId` always registers fine.
	 */
	groundingChecker?: GroundingChecker;
}

/**
 * A typed registry of algorithms. FX and graph algorithms live side by side,
 * distinguished by `family`.
 */
export class AlgorithmRegistry {
	private readonly byId = new Map<string, Algorithm<never>>();
	private readonly groundingChecker?: GroundingChecker;

	constructor(options: RegistryOptions = {}) {
		this.groundingChecker = options.groundingChecker;
	}

	/**
	 * Register one algorithm. Throws on duplicate id, or on an ungrounded
	 * coined metric (the boot-time operator-hud-grounding invariant).
	 */
	register<P>(algorithm: Algorithm<P>): this {
		if (this.byId.has(algorithm.id)) {
			throw new DuplicateAlgorithmError(algorithm.id);
		}
		if (algorithm.groundingConceptId) {
			const grounded =
				this.groundingChecker?.(algorithm.groundingConceptId) ?? false;
			if (!grounded) {
				throw new GroundingError(algorithm.id, algorithm.groundingConceptId);
			}
		}
		this.byId.set(algorithm.id, algorithm as unknown as Algorithm<never>);
		return this;
	}

	/** Register many; the whole batch is atomic only at the call level. */
	registerAll(algorithms: ReadonlyArray<Algorithm<any>>): this {
		for (const algorithm of algorithms) this.register(algorithm);
		return this;
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	/** Get an algorithm, re-narrowing its param type at the call site. */
	get<P = Record<string, never>>(id: string): Algorithm<P> | undefined {
		return this.byId.get(id) as Algorithm<P> | undefined;
	}

	/** List all algorithms, optionally filtered to one family. */
	list(family?: AlgorithmFamily): Array<Algorithm<never>> {
		const all = [...this.byId.values()];
		return family ? all.filter((a) => a.family === family) : all;
	}

	/** The set of families currently represented (drives curated-desk filtering). */
	families(): AlgorithmFamily[] {
		return [...new Set(this.list().map((a) => a.family))];
	}

	get size(): number {
		return this.byId.size;
	}
}

/** Convenience factory mirroring the rest of the codebase's create* style. */
export function createRegistry(
	options: RegistryOptions = {},
): AlgorithmRegistry {
	return new AlgorithmRegistry(options);
}
