/**
 * The single per-audience serializer — one exit, one choke point.
 *
 * Types alone cannot stop an identifier leaking into a label. Every payload is
 * built HERE, with audience gates, sensitive-data scans, closed-enum
 * validation, and audience-gated totals. Nothing else may construct a
 * GraphPayloadV1 — passing node shapes straight from a resolver into a
 * response is the failure mode this file exists to kill. The guarantee is a
 * single enforced choke point plus adversarial tests (see
 * __tests__/serializer.test.ts), not type-level magic.
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
	readonly rule: string;
	constructor(rule: string, message: string) {
		super(`[${rule}] ${message}`);
		this.name = "SerializerViolation";
		this.rule = rule;
	}
}

/**
 * Sensitive-identifier patterns (absolute). A decentralized identifier or an
 * email reaching the serializer means an upstream leak — throw loud, never
 * sanitize-and-serve.
 */
const DID_PATTERN = /\bdid:[a-z0-9]+:/i;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

const MEASURE_SET: ReadonlySet<string> = new Set(MEASURE_KINDS);
const PROVENANCE_SET: ReadonlySet<string> = new Set(PROVENANCES);
const SETTLEMENT_SET: ReadonlySet<string> = new Set(SETTLEMENT_STATES);
const TOKEN_LAYER_SET: ReadonlySet<string> = new Set(TOKEN_LAYERS);

function scanSensitive(rule: string, where: string, text: string): void {
	if (DID_PATTERN.test(text)) {
		throw new SerializerViolation(
			rule,
			`decentralized identifier detected in ${where} — such identifiers never enter payloads (public/member) or labels (any audience)`,
		);
	}
	if (EMAIL_PATTERN.test(text)) {
		throw new SerializerViolation(
			rule,
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
	/** Legacy id dual-emit for authenticated clients — refused on public payloads. */
	legacyIdMap?: Record<string, string>;
	/** Token layers the lens permits — enforced when provided. */
	allowedTokenLayers?: TokenLayer[];
}

export function buildPayload(input: BuildPayloadInput): GraphPayloadV1 {
	const { audience } = input;
	const seenRefs = new Set<string>();
	const allowedLayers = input.allowedTokenLayers
		? new Set<string>(input.allowedTokenLayers)
		: null;

	for (const node of input.nodes) {
		// Ref well-formedness + duplicate detection (identity: one node, one id).
		const { kind } = parseRef(node.id);
		if (seenRefs.has(node.id)) {
			throw new SerializerViolation(
				"identity",
				`duplicate node ref '${node.id}' — identity forked upstream`,
			);
		}
		seenRefs.add(node.id);

		// Audience gate: internally-keyed member refs are operator-only.
		if (kind === "member" && audience !== "operator") {
			throw new SerializerViolation(
				"pii",
				`kind 'member' ref '${node.id}' in a '${audience}' payload — a 'member'-kind ref is only valid in an 'operator' audience payload; use its public 'star:<publicRef>' form otherwise`,
			);
		}

		// Sensitive-identifier scans. Labels are scanned for EVERY audience (an
		// identifier/email is never a display string); ids are scanned outside
		// operator (operator member refs legitimately carry internal identifiers).
		scanSensitive("pii", `node label ('${node.id}')`, node.label);
		if (audience !== "operator") {
			scanSensitive("pii", `node id '${node.id}'`, node.id);
		}

		// Closed enums (honesty-as-type).
		if (!PROVENANCE_SET.has(node.provenance)) {
			throw new SerializerViolation(
				"provenance",
				`node '${node.id}' has invalid provenance '${node.provenance}'`,
			);
		}
		if (node.measures) {
			for (const key of Object.keys(node.measures)) {
				if (!MEASURE_SET.has(key)) {
					throw new SerializerViolation(
						"confidential",
						`node '${node.id}' carries unknown measure '${key}' — MeasureKind is a closed enum (no member exists for balances, by design)`,
					);
				}
			}
		}
		if (node.tokenLayer !== undefined) {
			if (!TOKEN_LAYER_SET.has(node.tokenLayer)) {
				throw new SerializerViolation(
					"confidential",
					`node '${node.id}' has unknown tokenLayer '${node.tokenLayer}'`,
				);
			}
			if (allowedLayers && !allowedLayers.has(node.tokenLayer)) {
				throw new SerializerViolation(
					"confidential",
					`node '${node.id}' carries tokenLayer '${node.tokenLayer}' not declared by the lens — mixing layers requires explicit declaration`,
				);
			}
		}

		// Position claim consistency: when the payload says positions are
		// included, every node carries finite coordinates (the server fills
		// gaps deterministically — community centroid — BEFORE serializing).
		if (input.positionsIncluded) {
			if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
				throw new SerializerViolation(
					"positions",
					`positionsIncluded=true but node '${node.id}' has no finite x/y — fill server-side (centroid fallback), never client-scatter`,
				);
			}
		}
	}

	const seenEdgeIds = new Set<string>();
	for (const edge of input.edges) {
		if (seenEdgeIds.has(edge.id)) {
			throw new SerializerViolation(
				"identity",
				`duplicate edge id '${edge.id}' — mint a discriminator for parallel edges`,
			);
		}
		seenEdgeIds.add(edge.id);
		// Dangling-edge check: id-space forks surface as edges pointing at
		// nodes that aren't in the payload.
		if (!seenRefs.has(edge.source) || !seenRefs.has(edge.target)) {
			throw new SerializerViolation(
				"identity",
				`edge '${edge.id}' references a node not in this payload (source='${edge.source}', target='${edge.target}') — id spaces forked upstream`,
			);
		}
		if (!PROVENANCE_SET.has(edge.provenance)) {
			throw new SerializerViolation(
				"provenance",
				`edge '${edge.id}' has invalid provenance '${edge.provenance}'`,
			);
		}
		if (
			edge.settlementState !== undefined &&
			!SETTLEMENT_SET.has(edge.settlementState)
		) {
			throw new SerializerViolation(
				"confidential",
				`edge '${edge.id}' has settlement state '${edge.settlementState}' outside the closed enum — no state may claim settled/final/atomic`,
			);
		}
	}

	// legacyIdMap is legacy plumbing for authenticated clients only.
	if (input.legacyIdMap && audience === "public") {
		throw new SerializerViolation(
			"contract",
			"legacyIdMap (legacy id dual-emit) never ships on public payloads",
		);
	}

	// Audience-gated totals: public gets the framing label only.
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
