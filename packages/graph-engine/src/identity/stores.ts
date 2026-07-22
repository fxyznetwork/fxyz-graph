/**
 * Id-keyed identity stores (engine law 13; audit RC7).
 *
 * Positions and selection key by GraphRef — never array index, never React
 * state inside the canvas subtree (audit RC5 lane-7). Framework-free
 * subscribable stores so React later binds via useSyncExternalStore.
 */

import type { GraphRef, PositionMap } from "@fxyz/graph-contract";

type Listener = () => void;

class Subscribable {
	private listeners = new Set<Listener>();
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	protected emit(): void {
		for (const l of this.listeners) l();
	}
}

export class PositionStore extends Subscribable {
	private positions = new Map<GraphRef, { x: number; y: number }>();

	setMany(positions: PositionMap): void {
		for (const [ref, pos] of Object.entries(positions)) {
			this.positions.set(ref as GraphRef, pos);
		}
		this.emit();
	}
	get(ref: GraphRef): { x: number; y: number } | undefined {
		return this.positions.get(ref);
	}
	/**
	 * Law-13 join guarantee: a position computed under one tier/payload joins
	 * under another by ref — the store never re-keys.
	 */
	snapshot(): PositionMap {
		return Object.fromEntries(this.positions) as PositionMap;
	}
	get size(): number {
		return this.positions.size;
	}
}

export class SelectionStore extends Subscribable {
	private selected = new Set<GraphRef>();

	select(refs: GraphRef[]): void {
		this.selected = new Set(refs);
		this.emit();
	}
	toggle(ref: GraphRef): void {
		if (this.selected.has(ref)) this.selected.delete(ref);
		else this.selected.add(ref);
		this.emit();
	}
	clear(): void {
		this.selected.clear();
		this.emit();
	}
	has(ref: GraphRef): boolean {
		return this.selected.has(ref);
	}
	snapshot(): GraphRef[] {
		return [...this.selected];
	}
}
