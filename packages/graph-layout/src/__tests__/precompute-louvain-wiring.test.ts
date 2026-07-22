/**
 * Louvain writer ⇄ positions stage wiring (#580-2) — fake-session end-to-end.
 *
 * Drives runLouvainPrecompute in FIRE mode against a scripted Session and
 * locks: (1) node writes carry rounded graphX/graphY in the same batched SET
 * as the community props, (2) :GraphCommunity rows carry x/y/r centroids,
 * (3) the whole fire is DETERMINISTIC end-to-end (seeded Louvain rng + seeded
 * layout), (4) warm-start priors flow from the read into the layout,
 * (5) rollback clears the position props.
 */

import type { Session } from "neo4j-driver";
import {
	COMPUTE_LABELS,
	rollbackLouvainPrecompute,
	runLouvainPrecompute,
} from "../precompute-louvain-core";

interface Call {
	cypher: string;
	params: Record<string, unknown>;
}

function rec(fields: Record<string, unknown>) {
	return { get: (key: string) => fields[key] ?? null };
}

function subscribable(rows: Array<Record<string, unknown>>) {
	return {
		subscribe(handlers: {
			onNext: (r: { get(k: string): unknown }) => void;
			onCompleted: () => void;
			onError: (e: unknown) => void;
		}) {
			for (const row of rows) handlers.onNext(rec(row));
			handlers.onCompleted();
		},
	};
}

/** Two disconnected triangles (communities) + their prior positions. */
function fixtureNodes(withPriors: boolean) {
	const label = COMPUTE_LABELS[0] as string;
	return Array.from({ length: 6 }, (_, i) => ({
		id: `el-${i}`,
		label,
		x: withPriors ? 100 + i * 10 : null,
		y: withPriors ? -50 + i * 5 : null,
	}));
}

const FIXTURE_EDGES = [
	{ source: "el-0", target: "el-1" },
	{ source: "el-1", target: "el-2" },
	{ source: "el-2", target: "el-0" },
	{ source: "el-3", target: "el-4" },
	{ source: "el-4", target: "el-5" },
	{ source: "el-5", target: "el-3" },
];

function fakeSession(withPriors = false): { session: Session; calls: Call[] } {
	const calls: Call[] = [];
	const session = {
		run(cypher: string, params?: Record<string, unknown>) {
			calls.push({ cypher, params: params ?? {} });
			if (/RETURN elementId\(n\) AS id, head/.test(cypher)) {
				return subscribable(fixtureNodes(withPriors));
			}
			if (/MATCH \(a\)-\[r\]->\(b\)/.test(cypher)) {
				return subscribable(FIXTURE_EDGES);
			}
			if (/MATCH \(o:Observation\)/.test(cypher)) {
				return subscribable([]);
			}
			if (/RETURN count\(n\) AS updated/.test(cypher)) {
				const rows = (params?.rows as unknown[]) ?? [];
				return Promise.resolve({ records: [rec({ updated: rows.length })] });
			}
			if (/AS linked/.test(cypher)) {
				return Promise.resolve({ records: [rec({ linked: 0 })] });
			}
			if (/AS removed/.test(cypher)) {
				return Promise.resolve({ records: [rec({ removed: 0 })] });
			}
			if (/AS deleted/.test(cypher)) {
				return Promise.resolve({ records: [rec({ deleted: 0 })] });
			}
			return Promise.resolve({ records: [] });
		},
	} as unknown as Session;
	return { session, calls };
}

function nodeWriteCalls(calls: Call[]): Call[] {
	return calls.filter((c) =>
		c.cypher.includes("n.louvainCommunity = toInteger"),
	);
}

function summaryCreateCalls(calls: Call[]): Call[] {
	return calls.filter(
		(c) =>
			c.cypher.includes("CREATE (c:GraphCommunity)") &&
			c.cypher.includes("c.x = row.x"),
	);
}

describe("runLouvainPrecompute — positions wiring (#580-2)", () => {
	it("fire writes rounded graphX/graphY in the SAME batched SET as the community props", async () => {
		const { session, calls } = fakeSession();
		const result = await runLouvainPrecompute(session, { fire: true });

		const writes = nodeWriteCalls(calls);
		expect(writes.length).toBeGreaterThan(0);
		expect(writes[0]?.cypher).toContain("n.graphX = row.x");
		expect(writes[0]?.cypher).toContain("n.graphY = row.y");
		const rows = writes.flatMap(
			(c) => c.params.rows as Array<{ id: string; x: number; y: number }>,
		);
		expect(rows).toHaveLength(6);
		for (const row of rows) {
			expect(Number.isFinite(row.x)).toBe(true);
			expect(Number.isFinite(row.y)).toBe(true);
			// rounded to 2 decimals
			expect(row.x).toBeCloseTo(Math.round(row.x * 100) / 100, 10);
		}
		expect(result.positionedNodes).toBe(6);
		expect(result.positionsUnpositioned).toBe(0);
	});

	it("fire writes x/y/r centroids onto :GraphCommunity rows", async () => {
		const { session, calls } = fakeSession();
		await runLouvainPrecompute(session, { fire: true });

		const creates = summaryCreateCalls(calls);
		expect(creates.length).toBeGreaterThan(0);
		const rows = creates.flatMap(
			(c) =>
				c.params.rows as Array<{
					x: number | null;
					y: number | null;
					r: number | null;
					props: { id: string };
				}>,
		);
		// Two triangles → two community super-nodes, each with a centroid + disc.
		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const row of rows) {
			expect(row.x).not.toBeNull();
			expect(row.y).not.toBeNull();
			expect(row.r).not.toBeNull();
			expect(row.r as number).toBeGreaterThan(0);
		}
	});

	it("is deterministic end-to-end: two fires over identical data produce identical rows", async () => {
		const a = fakeSession();
		const b = fakeSession();
		await runLouvainPrecompute(a.session, { fire: true });
		await runLouvainPrecompute(b.session, { fire: true });

		const rowsA = nodeWriteCalls(a.calls).flatMap((c) => c.params.rows);
		const rowsB = nodeWriteCalls(b.calls).flatMap((c) => c.params.rows);
		expect(rowsA).toEqual(rowsB);

		const sumA = summaryCreateCalls(a.calls).flatMap((c) => c.params.rows);
		const sumB = summaryCreateCalls(b.calls).flatMap((c) => c.params.rows);
		expect(sumA).toEqual(sumB);
	});

	it("warm-starts from prior graphX/graphY read off the slice", async () => {
		const { session } = fakeSession(true);
		const result = await runLouvainPrecompute(session, { fire: true });
		expect(result.positionsWarmStarted).toBe(6);
	});

	it("dry-run computes position stats but issues NO writes", async () => {
		const { session, calls } = fakeSession();
		const result = await runLouvainPrecompute(session, { fire: false });
		expect(result.positionedNodes).toBe(6);
		expect(result.positionsUnpositioned).toBe(0);
		expect(nodeWriteCalls(calls)).toHaveLength(0);
		expect(summaryCreateCalls(calls)).toHaveLength(0);
		expect(calls.some((c) => /DETACH DELETE/.test(c.cypher))).toBe(false);
	});

	it("rollback REMOVEs the position props alongside the community props", async () => {
		const { session, calls } = fakeSession();
		await rollbackLouvainPrecompute(session);
		const remove = calls.find((c) => c.cypher.includes("REMOVE"));
		expect(remove).toBeDefined();
		expect(remove?.cypher).toContain("n.graphX");
		expect(remove?.cypher).toContain("n.graphY");
		// The sweep must also CATCH position-only partial states.
		expect(remove?.cypher).toContain("n.graphX IS NOT NULL");
	});

	it("fire takes the advisory lock BEFORE reading and releases it after", async () => {
		const { session, calls } = fakeSession();
		await runLouvainPrecompute(session, { fire: true });
		const lockIdx = calls.findIndex((c) =>
			c.cypher.includes("MERGE (l:GraphPrecomputeLock"),
		);
		const readIdx = calls.findIndex((c) =>
			c.cypher.includes("RETURN elementId(n) AS id, head"),
		);
		expect(lockIdx).toBeGreaterThanOrEqual(0);
		expect(readIdx).toBeGreaterThan(lockIdx);
		const release = calls.filter((c) =>
			c.cypher.includes("l.heldSince = null"),
		);
		expect(release).toHaveLength(1);
	});

	it("refuses to fire while another write holds the lock — and writes NOTHING", async () => {
		const { session, calls } = fakeSession();
		const base = session.run.bind(session);
		(session as { run: unknown }).run = (
			cypher: string,
			params?: Record<string, unknown>,
		) => {
			if (cypher.includes("MERGE (l:GraphPrecomputeLock")) {
				calls.push({ cypher, params: params ?? {} });
				return Promise.resolve({
					records: [rec({ held: true, heldBy: "other-fire" })],
				});
			}
			return base(cypher, params);
		};
		await expect(runLouvainPrecompute(session, { fire: true })).rejects.toThrow(
			/louvain lock/,
		);
		expect(nodeWriteCalls(calls)).toHaveLength(0);
		expect(calls.some((c) => /DETACH DELETE/.test(c.cypher))).toBe(false);
	});

	it("dry-run never touches the lock", async () => {
		const { session, calls } = fakeSession();
		await runLouvainPrecompute(session, { fire: false });
		expect(calls.some((c) => c.cypher.includes("GraphPrecomputeLock"))).toBe(
			false,
		);
	});

	it("rollback also takes the lock (never interleaves with a fire)", async () => {
		const { session, calls } = fakeSession();
		await rollbackLouvainPrecompute(session);
		expect(
			calls.some((c) => c.cypher.includes("MERGE (l:GraphPrecomputeLock")),
		).toBe(true);
	});

	it("resolves exemplar names BEFORE the summary-tier DETACH DELETE (serving-gap order)", async () => {
		const { session, calls } = fakeSession();
		await runLouvainPrecompute(session, { fire: true });
		const deleteIdx = calls.findIndex((c) =>
			c.cypher.includes("MATCH (c:GraphCommunity) DETACH DELETE"),
		);
		const nameIdx = calls.findIndex((c) =>
			c.cypher.includes(
				// n.label last (#1056): FIBO classes carry their human-readable
				// rdfs label there ("board agreement"), nothing earlier in the
				// coalesce — without it every FiboClass community fell back to
				// "FiboClass cluster" on the public Overview.
				"coalesce(n.name, n.title, n.code, n.symbol, n.displayName, n.label) AS name",
			),
		);
		expect(deleteIdx).toBeGreaterThanOrEqual(0);
		expect(nameIdx).toBeGreaterThanOrEqual(0);
		expect(nameIdx).toBeLessThan(deleteIdx);
	});
});
