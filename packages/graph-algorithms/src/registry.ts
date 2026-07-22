/**
 * The algorithm registry + an optional registration guard.
 *
 * Registering an algorithm is how you add an analytic — there is no per-page
 * pipeline. The guard makes approval a registration-time invariant: an
 * algorithm that declares a `guardKey` cannot register unless the guard
 * approves that key. This lets you gate a class of algorithm (for example, a
 * coined metric that must be signed off) structurally, instead of relying on a
 * reviewer to catch it.
 *
 * The guard is INJECTED (a `RegistrationGuard`) rather than reaching into any
 * external system here, so this package stays pure/dependency-light. In an app
 * it is wired to whatever approves a key; in tests it is a stub.
 */

import type { Algorithm, AlgorithmFamily } from "./types";

/** Returns true iff the guard approves the given key. */
export type RegistrationGuard = (guardKey: string) => boolean;

/** Thrown when a guarded algorithm registers without approval. */
export class RegistrationError extends Error {
	constructor(
		public readonly algorithmId: string,
		public readonly guardKey: string,
	) {
		super(
			`Algorithm "${algorithmId}" declares guardKey "${guardKey}" but the ` +
				`registration guard did not approve it (or no RegistrationGuard was ` +
				`provided). A guarded algorithm must be approved before it can register.`,
		);
		this.name = "RegistrationError";
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
	 * Approves guarded algorithms. When omitted, ANY algorithm carrying a
	 * `guardKey` fails to register (fail-closed) — an algorithm with no
	 * `guardKey` always registers fine.
	 */
	registrationGuard?: RegistrationGuard;
}

/**
 * A typed registry of algorithms. FX and graph algorithms live side by side,
 * distinguished by `family`.
 */
export class AlgorithmRegistry {
	private readonly byId = new Map<string, Algorithm<never>>();
	private readonly registrationGuard?: RegistrationGuard;

	constructor(options: RegistryOptions = {}) {
		this.registrationGuard = options.registrationGuard;
	}

	/**
	 * Register one algorithm. Throws on duplicate id, or on a guarded algorithm
	 * the registration guard does not approve.
	 */
	register<P>(algorithm: Algorithm<P>): this {
		if (this.byId.has(algorithm.id)) {
			throw new DuplicateAlgorithmError(algorithm.id);
		}
		if (algorithm.guardKey) {
			const approved = this.registrationGuard?.(algorithm.guardKey) ?? false;
			if (!approved) {
				throw new RegistrationError(algorithm.id, algorithm.guardKey);
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
