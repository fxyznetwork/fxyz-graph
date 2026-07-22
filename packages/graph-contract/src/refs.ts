/**
 * Canonical graph identity — the RC7 fix.
 *
 * ID LAW (DESIGN-V2 §2, codex-hardened): a GraphRef is stable across every
 * surface, tier, lens, and refetch *within one audience projection*. The
 * server owns the cross-audience mapping; public refs are never derivable
 * from internal refs; positions and selection key by ref, never array index.
 *
 * Member rule (PII absolute): public/member payloads identify members as
 * `star:<publicRef>` (a durable opaque key minted once — star names are
 * DISPLAY, publicRef is IDENTITY); `member:<did>` refs exist only in
 * operator projections. Neo4j elementId never leaves the resolver layer.
 */

/**
 * Node kinds v1. Extensible by design (apophatic — no fixed cardinality
 * assumption anywhere), but extension is deliberate: a new kind must be added
 * here AND to the serializer's audience gates before it can ship (allowlist,
 * not denylist — engine law 1).
 */
export const NODE_KINDS = [
	"currency",
	"institution",
	"country",
	"corridor",
	"star", // member, public-safe identity (publicRef key)
	"member", // member, operator-only identity (DID key) — never public
	"concept",
	"citation",
	"community", // LOD super-node — EPHEMERAL, version-qualified key
	"circle",
	"role",
	"domain", // holacracy :Domain (slug-keyed, structural — no gate beyond member law)
	"code", // graphify :CodeSymbol lens family
	"indicator",
	"token",
	"asset",
	"cbdc",
	"partner",
	"fibo",
	"constellation",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Audience projections. Refs and payloads are scoped to exactly one. */
export const AUDIENCES = ["public", "member", "operator"] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * One node, one id — `kind:key`. Opaque to consumers; constructed only via
 * makeRef/make*Ref so key rules are enforced at mint time.
 */
export type GraphRef = `${NodeKind}:${string}`;

/**
 * Edge ids are minted server-side and deterministic (codex finding 8):
 * `edge:{type}:{sourceRef}→{targetRef}[:{discriminator}]`. Parallel edges
 * (quotes, settlement legs, repeated rel-types) MUST carry a stable
 * discriminator. Diffing, selection, deletion, URL state, and replay all
 * key on EdgeId.
 */
export type EdgeId = `edge:${string}`;

const KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);

/**
 * The positional-synthetic pattern the legacy public source minted for
 * members with no starName (`member-{magnitudeClass}-{batchIndex}`). Those
 * ids change with ordering/limits/membership — banned as ref keys (engine
 * law 13; codex finding 2). Narrow on purpose: legitimate keys ending in
 * digits (e.g. `HIP24436`) must pass.
 */
const POSITIONAL_SYNTHETIC = /^member-[a-z0-9]+-\d+$/i;

export class GraphRefViolation extends Error {
	readonly law: string;
	constructor(law: string, message: string) {
		super(`[${law}] ${message}`);
		this.name = "GraphRefViolation";
		this.law = law;
	}
}

/** Mint a ref. Throws GraphRefViolation on rule breaches — never sanitizes. */
export function makeRef(kind: NodeKind, key: string): GraphRef {
	if (!KIND_SET.has(kind)) {
		throw new GraphRefViolation("law-13", `unknown node kind '${kind}'`);
	}
	const trimmed = key.trim();
	if (trimmed.length === 0) {
		throw new GraphRefViolation("law-13", `empty key for kind '${kind}'`);
	}
	if (POSITIONAL_SYNTHETIC.test(trimmed)) {
		throw new GraphRefViolation(
			"law-13",
			`positional synthetic id '${trimmed}' cannot be a ref key — mint a durable publicRef instead (DESIGN-V2 §2 / codex 2)`,
		);
	}
	if (trimmed.includes(":") && kind !== "code") {
		// ':' is the kind separator; only the code kind may carry path-like
		// keys with colons stripped by its own maker below.
		throw new GraphRefViolation(
			"law-13",
			`key '${trimmed}' contains ':' — keys must be colon-free (kind '${kind}')`,
		);
	}
	return `${kind}:${trimmed}` as GraphRef;
}

/** Parse a ref back into { kind, key }. Throws on malformed input. */
export function parseRef(ref: string): { kind: NodeKind; key: string } {
	const sep = ref.indexOf(":");
	if (sep <= 0 || sep === ref.length - 1) {
		throw new GraphRefViolation("law-13", `malformed ref '${ref}'`);
	}
	const kind = ref.slice(0, sep);
	if (!KIND_SET.has(kind)) {
		throw new GraphRefViolation("law-13", `unknown kind in ref '${ref}'`);
	}
	return { kind: kind as NodeKind, key: ref.slice(sep + 1) };
}

export function isGraphRef(value: unknown): value is GraphRef {
	if (typeof value !== "string") return false;
	try {
		parseRef(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * Community refs are outputs of a particular graph snapshot + algorithm run —
 * `community:42` after a Louvain re-run silently points at a different
 * population (codex finding 4). The dataVersion is therefore part of the key,
 * and community refs are EPHEMERAL: never persisted (saved views, URLs)
 * without their dataVersion.
 */
export function makeCommunityRef(
	dataVersion: string | number,
	communityId: string | number,
): GraphRef {
	const dv = String(dataVersion).trim();
	const id = String(communityId).trim();
	if (!dv || !id) {
		throw new GraphRefViolation(
			"law-13",
			"community ref requires both dataVersion and communityId",
		);
	}
	return makeRef("community", `v${dv}-${id}`);
}

/**
 * Corridor refs are direction-normalized and rail/venue-qualified where a
 * rail exists (codex finding 4). Direction is MEANINGFUL for corridors
 * (send→receive), so it is preserved — normalization here means a canonical
 * spelling (upper-cased codes, single separator), not sorting.
 * The two corridor node families (:Corridor money-routing vs :P2PCorridor)
 * must never conflate — the optional `family` qualifier carries that.
 */
export function makeCorridorRef(input: {
	send: string;
	receive: string;
	rail?: string;
	family?: "routing" | "p2p";
}): GraphRef {
	const send = input.send.trim().toUpperCase();
	const receive = input.receive.trim().toUpperCase();
	if (!send || !receive) {
		throw new GraphRefViolation(
			"law-13",
			"corridor ref requires send and receive",
		);
	}
	const parts = [`${send}→${receive}`];
	if (input.family) parts.push(input.family);
	if (input.rail) parts.push(input.rail.trim().toLowerCase());
	return makeRef("corridor", parts.join("·"));
}

/** Code-symbol refs allow path-like keys; colons are normalized away. */
export function makeCodeRef(symbolPath: string): GraphRef {
	const key = symbolPath.trim().replaceAll(":", "/");
	return makeRef("code", key);
}

/** Deterministic edge id (see EdgeId). */
export function makeEdgeId(
	type: string,
	source: GraphRef,
	target: GraphRef,
	discriminator?: string,
): EdgeId {
	const t = type.trim();
	if (!t) throw new GraphRefViolation("law-13", "edge type required");
	const base = `edge:${t}:${source}→${target}`;
	return (discriminator ? `${base}:${discriminator.trim()}` : base) as EdgeId;
}

/**
 * Ref lifecycle (codex finding 3): natural keys mutate (star renames, code
 * moves, corrected identifiers). Renames mint an alias entry; persisted refs
 * (saved views, URLs) resolve through aliases server-side. Kept as a type
 * here — storage is the server's (P1).
 */
export interface RefAlias {
	/** The ref as persisted before the rename/move. */
	from: GraphRef;
	/** The ref that supersedes it. */
	to: GraphRef;
	/** ISO date the alias was minted. */
	since: string;
	reason: "rename" | "move" | "correction" | "merge";
}
