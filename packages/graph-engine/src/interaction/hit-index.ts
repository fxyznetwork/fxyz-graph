/**
 * Own interaction layer primitives.
 *
 * A renderer's stock hover-interaction handling can run an UNTHROTTLED
 * linear scan per mousemove (measured: 25.6/9.9/4.5 fps at 25/50/100k vs
 * 60/59.7/58.7 without). The engine owns hit-testing instead: uniform
 * spatial grids for nodes AND edge segments (SegmentGrid; an unindexed edge
 * fallback would reintroduce the linear scan) and a
 * trailing-edge throttle at zoom parity (25ms).
 */

export interface IndexedPoint {
	id: string;
	x: number;
	y: number;
}

export class SpatialGrid {
	private readonly cells = new Map<string, IndexedPoint[]>();
	readonly cellSize: number;
	private count = 0;

	constructor(points: IndexedPoint[], cellSize = 64) {
		this.cellSize = cellSize;
		for (const p of points) {
			if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
			const key = this.keyFor(p.x, p.y);
			const bucket = this.cells.get(key);
			if (bucket) bucket.push(p);
			else this.cells.set(key, [p]);
			this.count += 1;
		}
	}

	private keyFor(x: number, y: number): string {
		return `${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`;
	}

	get size(): number {
		return this.count;
	}

	/**
	 * Candidates within `radius` of (x,y) — visits only the covered cells, so
	 * pointer cost is bounded by local density, independent of graph size N.
	 */
	query(x: number, y: number, radius: number): IndexedPoint[] {
		const out: IndexedPoint[] = [];
		const r2 = radius * radius;
		const minCx = Math.floor((x - radius) / this.cellSize);
		const maxCx = Math.floor((x + radius) / this.cellSize);
		const minCy = Math.floor((y - radius) / this.cellSize);
		const maxCy = Math.floor((y + radius) / this.cellSize);
		for (let cx = minCx; cx <= maxCx; cx += 1) {
			for (let cy = minCy; cy <= maxCy; cy += 1) {
				const bucket = this.cells.get(`${cx}:${cy}`);
				if (!bucket) continue;
				for (const p of bucket) {
					const dx = p.x - x;
					const dy = p.y - y;
					if (dx * dx + dy * dy <= r2) out.push(p);
				}
			}
		}
		return out;
	}

	/** Test hook: how many cells a query touches. */
	cellsTouched(x: number, y: number, radius: number): number {
		const minCx = Math.floor((x - radius) / this.cellSize);
		const maxCx = Math.floor((x + radius) / this.cellSize);
		const minCy = Math.floor((y - radius) / this.cellSize);
		const maxCy = Math.floor((y + radius) / this.cellSize);
		return (maxCx - minCx + 1) * (maxCy - minCy + 1);
	}
}

export interface IndexedSegment {
	id: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

/** Squared point→segment distance (projection clamped to the segment). */
export function pointSegmentDistance2(
	px: number,
	py: number,
	s: IndexedSegment,
): number {
	const dx = s.x2 - s.x1;
	const dy = s.y2 - s.y1;
	const len2 = dx * dx + dy * dy;
	const t =
		len2 === 0
			? 0
			: Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len2));
	const cx = s.x1 + t * dx - px;
	const cy = s.y1 + t * dy - py;
	return cx * cx + cy * cy;
}

/**
 * Edge-segment spatial index (an unindexed edge fallback would reintroduce
 * the linear scan noted above). Each segment registers in every grid cell it passes through
 * (sampled walk at half-cell steps, deduped); queries visit only covered
 * cells, so tap cost is bounded by local density, independent of edge count.
 */
export class SegmentGrid {
	private readonly cells = new Map<string, IndexedSegment[]>();
	readonly cellSize: number;
	private count = 0;

	constructor(segments: IndexedSegment[], cellSize = 64) {
		this.cellSize = cellSize;
		const step = cellSize / 2;
		for (const s of segments) {
			if (
				!Number.isFinite(s.x1) ||
				!Number.isFinite(s.y1) ||
				!Number.isFinite(s.x2) ||
				!Number.isFinite(s.y2)
			) {
				continue;
			}
			const length = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
			const samples = Math.max(1, Math.ceil(length / step));
			const seen = new Set<string>();
			for (let i = 0; i <= samples; i += 1) {
				const t = i / samples;
				const key = this.keyFor(
					s.x1 + (s.x2 - s.x1) * t,
					s.y1 + (s.y2 - s.y1) * t,
				);
				if (seen.has(key)) continue;
				seen.add(key);
				const bucket = this.cells.get(key);
				if (bucket) bucket.push(s);
				else this.cells.set(key, [s]);
			}
			this.count += 1;
		}
	}

	private keyFor(x: number, y: number): string {
		return `${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`;
	}

	get size(): number {
		return this.count;
	}

	/** Segments within `radius` of (x,y) — covered cells only, deduped. */
	query(x: number, y: number, radius: number): IndexedSegment[] {
		const out: IndexedSegment[] = [];
		const found = new Set<string>();
		const r2 = radius * radius;
		const minCx = Math.floor((x - radius) / this.cellSize);
		const maxCx = Math.floor((x + radius) / this.cellSize);
		const minCy = Math.floor((y - radius) / this.cellSize);
		const maxCy = Math.floor((y + radius) / this.cellSize);
		for (let cx = minCx; cx <= maxCx; cx += 1) {
			for (let cy = minCy; cy <= maxCy; cy += 1) {
				const bucket = this.cells.get(`${cx}:${cy}`);
				if (!bucket) continue;
				for (const s of bucket) {
					if (found.has(s.id)) continue;
					if (pointSegmentDistance2(x, y, s) <= r2) {
						found.add(s.id);
						out.push(s);
					}
				}
			}
		}
		return out;
	}
}

/**
 * Trailing-edge throttle at hover/zoom parity (rule: ≥25ms). Injectable
 * clock so tests are deterministic.
 */
export function throttle<Args extends unknown[]>(
	fn: (...args: Args) => void,
	intervalMs = 25,
	now: () => number = () => Date.now(),
): (...args: Args) => void {
	let last = Number.NEGATIVE_INFINITY;
	return (...args: Args) => {
		const t = now();
		if (t - last >= intervalMs) {
			last = t;
			fn(...args);
		}
	};
}
