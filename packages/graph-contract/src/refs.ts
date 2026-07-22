/**
 * Canonical graph identity.
 *
 * A GraphRef is stable across every surface, tier, lens, and refetch within
 * one audience projection. The server owns the cross-audience mapping; public
 * refs are never derivable from internal refs; positions and selection key by
 * ref, never by array index.
 *
 * Identity rule for people: public/member payloads identify a person by a
 * durable opaque public key (`star:<publicRef>`) — display names are separate
 * from identity; internal person refs (`member:<key>`) exist only in operator
 * projections and never reach a public payload.
 */

/**
 * The reference node-kind set for this library — the domain vocabulary the
 * fxyz graph is modelled in (currencies, institutions, corridors, tokens,
 * members, and so on). It is NOT a universal schema: if you are modelling a
 * different domain, fork or extend this list. The set is intentionally closed
 * — a new kind is a deliberate addition here AND to the serializer's audience
 * gates (allowlist, not denylist), never an ad-hoc string.
 */
export const NODE_KINDS = [
	"currency",
	"institution",
	"country",
	"corridor",
	"star", // person, public-safe identity (opaque publicRef key)
	"member", // person, operator-only identity (internal key) — never public
	"concept",
	"citation",
	"community", // level-of-detail super-node — ephemeral, version-qualified key
	"circle",
	"role",
	"domain", // structural grouping (slug-keyed)
	"code", // code-symbol lens family
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
 * Edge ids are minted server-side and deterministic:
 * `edge:{type}:{sourceRef}→{targetRef}[:{discriminator}]`. Parallel edges
 * (quotes, settlement legs, repeated relationship types) MUST carry a stable
 * discriminator. Diffing, selection, deletion, URL state, and replay all
 * key on EdgeId.
 */
export type EdgeId = `edge:${string}`;

const KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);

/**
 * A positional-synthetic id pattern (`member-{class}-{index}`) whose value
 * depends on ordering/limits/membership. Such ids are unstable across
 * refetches, so they are banned as ref keys. Narrow on purpose: legitimate
 * keys ending in digits (e.g. `HIP24436`) must pass.
 */
const POSITIONAL_SYNTHETIC = /^member-[a-z0-9]+-\d+$/i;

export class GraphRefViolation extends Error {
	readonly rule: string;
	constructor(rule: string, message: string) {
		super(`[${rule}] ${message}`);
		this.name = "GraphRefViolation";
		this.rule = rule;
	}
}

/** Mint a ref. Throws GraphRefViolation on rule breaches — never sanitizes. */
export function makeRef(kind: NodeKind, key: string): GraphRef {
	if (!KIND_SET.has(kind)) {
		throw new GraphRefViolation("identity", `unknown node kind '${kind}'`);
	}
	const trimmed = key.trim();
	if (trimmed.length === 0) {
		throw new GraphRefViolation("identity", `empty key for kind '${kind}'`);
	}
	if (POSITIONAL_SYNTHETIC.test(trimmed)) {
		throw new GraphRefViolation(
			"identity",
			`positional synthetic id '${trimmed}' cannot be a ref key — mint a durable opaque publicRef instead`,
		);
	}
	if (trimmed.includes(":") && kind !== "code") {
		// ':' is the kind separator; only the code kind may carry path-like
		// keys with colons stripped by its own maker below.
		throw new GraphRefViolation(
			"identity",
			`key '${trimmed}' contains ':' — keys must be colon-free (kind '${kind}')`,
		);
	}
	return `${kind}:${trimmed}` as GraphRef;
}

/** Parse a ref back into { kind, key }. Throws on malformed input. */
export function parseRef(ref: string): { kind: NodeKind; key: string } {
	const sep = ref.indexOf(":");
	if (sep <= 0 || sep === ref.length - 1) {
		throw new GraphRefViolation("identity", `malformed ref '${ref}'`);
	}
	const kind = ref.slice(0, sep);
	if (!KIND_SET.has(kind)) {
		throw new GraphRefViolation("identity", `unknown kind in ref '${ref}'`);
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
 * population. The dataVersion is therefore part of the key, and community refs
 * are EPHEMERAL: never persisted (saved views, URLs) without their dataVersion.
 */
export function makeCommunityRef(
	dataVersion: string | number,
	communityId: string | number,
): GraphRef {
	const dv = String(dataVersion).trim();
	const id = String(communityId).trim();
	if (!dv || !id) {
		throw new GraphRefViolation(
			"identity",
			"community ref requires both dataVersion and communityId",
		);
	}
	return makeRef("community", `v${dv}-${id}`);
}

/**
 * Corridor refs are direction-normalized and rail-qualified where a rail
 * exists. Direction is MEANINGFUL for corridors (send→receive), so it is
 * preserved — normalization here means a canonical spelling (upper-cased
 * codes, single separator), not sorting. The optional `family` qualifier
 * keeps distinct corridor families (routing vs p2p) from conflating.
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
			"identity",
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
	if (!t) throw new GraphRefViolation("identity", "edge type required");
	const base = `edge:${t}:${source}→${target}`;
	return (discriminator ? `${base}:${discriminator.trim()}` : base) as EdgeId;
}

/**
 * Ref lifecycle: natural keys sometimes change (renames, moves, corrected
 * identifiers). A rename mints an alias entry so persisted refs (saved views,
 * URLs) resolve through the alias. This is the shape only — the server owns
 * where aliases are stored.
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
