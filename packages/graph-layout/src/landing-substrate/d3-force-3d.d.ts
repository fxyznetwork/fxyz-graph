/**
 * Local type shim for d3-force-3d (no @types/d3-force-3d on npm).
 *
 * The library mirrors d3-force's API in 3D: forceSimulation accepts a
 * dimensionality argument, forceX/Y/Z work like forceX/Y from d3-force.
 * Types are loosened to `any` here intentionally — the consumer in
 * `force-layout.ts` casts via the SimNode interface and it suffices.
 */
declare module "d3-force-3d" {
	export interface Simulation<NodeDatum, LinkDatum> {
		nodes(): NodeDatum[];
		nodes(nodes: NodeDatum[]): this;
		alpha(): number;
		alpha(alpha: number): this;
		alphaDecay(): number;
		alphaDecay(decay: number): this;
		alphaMin(): number;
		alphaMin(min: number): this;
		alphaTarget(): number;
		alphaTarget(target: number): this;
		velocityDecay(): number;
		velocityDecay(decay: number): this;
		force(name: string): unknown;
		force(name: string, force: unknown | null): this;
		find(
			x: number,
			y: number,
			z: number,
			radius?: number,
		): NodeDatum | undefined;
		on(typenames: string, listener: (() => void) | null): this;
		tick(iterations?: number): this;
		stop(): this;
		restart(): this;
	}

	export function forceSimulation<NodeDatum>(
		nodes?: NodeDatum[],
		dimensions?: number,
	): Simulation<NodeDatum, undefined>;

	export interface ForceLink<NodeDatum, LinkDatum> {
		(alpha: number): void;
		links(): LinkDatum[];
		links(links: LinkDatum[]): this;
		id(accessor: (n: NodeDatum) => string | number): this;
		distance(distance: number | ((link: LinkDatum) => number)): this;
		strength(strength: number | ((link: LinkDatum) => number)): this;
		iterations(iterations: number): this;
	}

	export function forceLink<NodeDatum, LinkDatum>(
		links?: LinkDatum[],
	): ForceLink<NodeDatum, LinkDatum>;

	export interface ForceManyBody<NodeDatum> {
		(alpha: number): void;
		strength(strength: number | ((n: NodeDatum) => number)): this;
		theta(theta: number): this;
		distanceMin(distance: number): this;
		distanceMax(distance: number): this;
	}

	export function forceManyBody<NodeDatum>(): ForceManyBody<NodeDatum>;

	export interface ForceCollide<NodeDatum> {
		(alpha: number): void;
		radius(radius: number | ((n: NodeDatum) => number)): this;
		strength(strength: number): this;
		iterations(iterations: number): this;
	}

	export function forceCollide<NodeDatum>(
		radius?: number | ((n: NodeDatum) => number),
	): ForceCollide<NodeDatum>;

	export interface ForceCenter {
		(alpha: number): void;
		x(x: number): this;
		y(y: number): this;
		z(z: number): this;
		strength(strength: number): this;
	}

	export function forceCenter(x?: number, y?: number, z?: number): ForceCenter;

	export interface ForceAxis<NodeDatum> {
		(alpha: number): void;
		strength(strength: number | ((n: NodeDatum) => number)): this;
		x?(value: number | ((n: NodeDatum) => number)): this;
	}

	export function forceX<NodeDatum>(
		x?: number | ((n: NodeDatum) => number),
	): ForceAxis<NodeDatum>;

	export function forceY<NodeDatum>(
		y?: number | ((n: NodeDatum) => number),
	): ForceAxis<NodeDatum>;

	export function forceZ<NodeDatum>(
		z?: number | ((n: NodeDatum) => number),
	): ForceAxis<NodeDatum>;
}
