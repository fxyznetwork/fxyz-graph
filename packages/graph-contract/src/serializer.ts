/**
 * The single per-audience serializer — one exit, one choke point
 * (DESIGN-V2 §2; codex findings 5, 6, 7, 13).
 *
 * Types alone cannot stop a DID in a label. Every payload is built HERE, with
 * audience gates, PII scans, closed-enum validation, and audience-gated
 * totals. Nothing else may construct a GraphPayloadV1 — importing node shapes
 * straight from a resolver into a response is the failure mode this file
 * exists to kill. "Structural" honestly means: single enforced choke point +
 * adversarial tests (see __tests__/serializer.test.ts), not typewise magic.
 */

import {
	MEASURE_KINDS,
	PROVENANCES,
	SETTLEMENT_STATES,
	TOKEN_LAYERS,
	type TokenLayer,
} from "./enums";
import {
	buildCacheKey,
	type CoverageInfo,
	type GraphEdgeV1,
	type GraphNodeV1,
	type GraphPayloadV1,
	PAYLOAD_VERSION,
	type Tier,
} from "./payload";
import type { Audience } from "./refs";
import { parseRef } from "./refs";

export class SerializerViolation extends Error {
	readonly law: string;
	constructor(law: string, message: string) {
		super(`[${law}] ${message}`);
		this.name = "SerializerViolation";
		this.law = law;
	}
}

/**
 * PII patterns (pii-rules.md, absolute). A DID or email reaching the
 * serializer means an upstream leak — throw loud, never sanitize-and-serve.
 */
const DID_PATTERN = /\bdid:[a-z0-9]+:/i;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

const MEASURE_SET: ReadonlySet<string> = new Set(MEASURE_KINDS);
const PROVENANCE_SET: ReadonlySet<string> = new Set(PROVENANCES);
const SETTLEMENT_SET: ReadonlySet<string> = new Set(SETTLEMENT_STATES);
const TOKEN_LAYER_SET: ReadonlySet<string> = new Set(TOKEN_LAYERS);

function scanPii(law: string, where: string, text: string): void {
	if (DID_PATTERN.test(text)) {
		throw new SerializerViolation(
			law,
			`DID detected in ${where} — DIDs never enter payloads (public/member) or labels (any audience)`,
		);
	}
	if (EMAIL_PATTERN.test(text)) {
		throw new SerializerViolation(
			law,
			`email detected in ${where} — emails never enter payloads`,
		);
	}
}

export interface BuildPayloadInput {
	audience: Audience;
	tier: Tier;
	lens: string;
	scope: string;
	dataVersion: string;
	aclVersion: string;
	nodes: GraphNodeV1[];
	edges: GraphEdgeV1[];
	coverage: CoverageInfo;
	sampled: boolean;
	positionsIncluded: boolean;
	/** Drain-era dual-emit — refused on public payloads. */
	legacyIdMap?: Record<string, string>;
	/** From the LensSpec — enforced when provided (codex 15). */
	allowedTokenLayers?: TokenLayer[];
}

export function buildPayload(input: BuildPayloadInput): GraphPayloadV1 {
	const { audience } = input;
	const seenRefs = new Set<string>();
	const allowedLayers = input.allowedTokenLayers
		? new Set<string>(input.allowedTokenLayers)
		: null;

	for (const node of input.nodes) {
		// Ref well-formedness + duplicate detection (law 13: one node, one id).
		const { kind } = parseRef(node.id);
		if (seenRefs.has(node.id)) {
			throw new SerializerViolation(
				"law-13",
				`duplicate node ref '${node.id}' — identity forked upstream`,
			);
		}
		seenRefs.add(node.id);

		// Audience gate: DID-keyed member refs are operator-only (ID LAW).
		if (kind === "member" && audience !== "operator") {
			throw new SerializerViolation(
				"law-3-pii",
				`kind 'member' ref '${node.id}' in a '${audience}' payload — members are 'star:<publicRef>' outside operator projections`,
			);
		}

		// PII scans. Labels are scanned for EVERY audience (a DID/email is
		// never a display string); ids are scanned outside operator (operator
		// member refs legitimately carry DIDs).
		scanPii("law-3-pii", `node label ('${node.id}')`, node.label);
		if (audience !== "operator") {
			scanPii("law-3-pii", `node id '${node.id}'`, node.id);
		}

		// Closed enums (law 17 + honesty-as-type).
		if (!PROVENANCE_SET.has(node.provenance)) {
			throw new SerializerViolation(
				"law-16",
				`node '${node.id}' has invalid provenance '${node.provenance}'`,
			);
		}
		if (node.measures) {
			for (const key of Object.keys(node.measures)) {
				if (!MEASURE_SET.has(key)) {
					throw new SerializerViolation(
						"law-17",
						`node '${node.id}' carries unknown measure '${key}' — MeasureKind is a closed enum (no member exists for balances, by design)`,
					);
				}
			}
		}
		if (node.tokenLayer !== undefined) {
			if (!TOKEN_LAYER_SET.has(node.tokenLayer)) {
				throw new SerializerViolation(
					"law-17",
					`node '${node.id}' has unknown tokenLayer '${node.tokenLayer}'`,
				);
			}
			if (allowedLayers && !allowedLayers.has(node.tokenLayer)) {
				throw new SerializerViolation(
					"law-17",
					`node '${node.id}' carries tokenLayer '${node.tokenLayer}' not declared by the lens (token-layer-distinction: mixing requires explicit declaration)`,
				);
			}
		}

		// Position claim consistency: when the payload says positions are
		// included, every node carries finite coordinates (the server fills
		// gaps deterministically — community centroid — BEFORE serializing).
		if (input.positionsIncluded) {
			if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
				throw new SerializerViolation(
					"law-5",
					`positionsIncluded=true but node '${node.id}' has no finite x/y — fill server-side (centroid fallback), never client-scatter`,
				);
			}
		}
	}

	const seenEdgeIds = new Set<string>();
	for (const edge of input.edges) {
		if (seenEdgeIds.has(edge.id)) {
			throw new SerializerViolation(
				"law-13",
				`duplicate edge id '${edge.id}' — mint a discriminator for parallel edges`,
			);
		}
		seenEdgeIds.add(edge.id);
		// Dangling-edge check: id-space forks surface as edges pointing at
		// nodes that aren't in the payload.
		if (!seenRefs.has(edge.source) || !seenRefs.has(edge.target)) {
			throw new SerializerViolation(
				"law-13",
				`edge '${edge.id}' references a node not in this payload (source='${edge.source}', target='${edge.target}') — id spaces forked upstream`,
			);
		}
		if (!PROVENANCE_SET.has(edge.provenance)) {
			throw new SerializerViolation(
				"law-16",
				`edge '${edge.id}' has invalid provenance '${edge.provenance}'`,
			);
		}
		if (
			edge.settlementState !== undefined &&
			!SETTLEMENT_SET.has(edge.settlementState)
		) {
			throw new SerializerViolation(
				"law-17",
				`edge '${edge.id}' has settlement state '${edge.settlementState}' outside the closed enum — no state may claim settled/final/PvP`,
			);
		}
	}

	// legacyIdMap is drain-era plumbing for authenticated clients only.
	if (input.legacyIdMap && audience === "public") {
		throw new SerializerViolation(
			"law-15",
			"legacyIdMap (elementId dual-emit) never ships on public payloads",
		);
	}

	// Audience-gated totals (codex 13): public gets the framing label only.
	const coverage: CoverageInfo =
		audience === "public"
			? { framing: input.coverage.framing }
			: input.coverage;

	return {
		version: PAYLOAD_VERSION,
		audience,
		tier: input.tier,
		nodes: input.nodes,
		edges: input.edges,
		...(input.legacyIdMap ? { legacyIdMap: input.legacyIdMap } : {}),
		coverage,
		sampled: input.sampled,
		positionsIncluded: input.positionsIncluded,
		cacheKey: buildCacheKey({
			lens: input.lens,
			scope: input.scope,
			tier: input.tier,
			dataVersion: input.dataVersion,
			audience,
			aclVersion: input.aclVersion,
		}),
	};
}
