/**
 * Run an effect exactly once on mount (project convention: never a bare
 * useEffect-with-[] scattered through components). Local copy — this package
 * cannot depend on the design-system.
 */

import { useEffect, useRef } from "react";

export function useMountEffect(effect: () => void | (() => void)): void {
	const ran = useRef(false);
	const cleanup = useRef<void | (() => void)>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only by contract
	useEffect(() => {
		if (ran.current) return;
		ran.current = true;
		cleanup.current = effect();
		return () => {
			if (typeof cleanup.current === "function") cleanup.current();
		};
	}, []);
}
