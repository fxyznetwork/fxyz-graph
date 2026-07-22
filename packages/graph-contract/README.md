# `@fxyz/graph-contract`

The identity and payload contract every other layer in this stack signs.
**Zero runtime dependencies.** It defines how a graph is identified, serialized,
and budgeted so that a server resolver, the graph engine, and any renderer all
agree on node identity — nothing above this contract may fork it.

## What it gives you

- **Stable identity** — a `GraphRef` (`kind:key`) minted only through
  `makeRef` / `makeEdgeId` / `makeCommunityRef` / `makeCorridorRef`, so key
  rules (no colons, no unstable positional-synthetic ids, version-qualified
  community refs) are enforced at mint time. Positions and selection key by
  ref, never by array index.
- **A single serializer choke point** — `buildPayload` is the only way to
  construct a `GraphPayloadV1`. It runs audience gates, sensitive-data scans
  (an identifier or email in a label throws, never serves), closed-enum
  validation, and audience-gated totals.
- **Honesty-as-types** — closed enums (`PROVENANCES`, `MEASURE_KINDS`,
  `SETTLEMENT_STATES`, `TOKEN_LAYERS`, `DATA_ROLES`) whose *absence* of members
  is the enforcement: there is no "balance" measure and no "settled/final"
  settlement state, by design.
- **Provenanced budgets** — `DEFAULT_TIER_BUDGETS` per render tier, each number
  carrying a `provenance` (`measured` | `provisional`) so magic numbers can't
  creep in.
- **A lens registry** — `LENS_REGISTRY` / `LensSpec`, the shared vocabulary of
  lens ids (which node kinds, which style rules, which tier).

## Usage

```ts
import { makeRef, makeEdgeId, buildPayload } from "@fxyz/graph-contract";

const eur = makeRef("currency", "EUR");   // "currency:EUR"
const brl = makeRef("currency", "BRL");

const payload = buildPayload({
  audience: "public",
  tier: "panel",
  lens: "market",
  scope: "overview",
  dataVersion: "dv1",
  aclVersion: "acl1",
  nodes: [
    { id: eur, kind: "currency", label: "Euro", provenance: "real" },
    { id: brl, kind: "currency", label: "Brazilian Real", provenance: "real" },
  ],
  edges: [
    { id: makeEdgeId("QUOTES", eur, brl), source: eur, target: brl, type: "QUOTES", provenance: "real" },
  ],
  coverage: { framing: "curated" },
  sampled: false,
  positionsIncluded: false,
});
// buildPayload throws a SerializerViolation if a label carries a DID/email,
// if an id is malformed, if a measure is off-enum, or if an edge dangles.
```

## Domain note

`NODE_KINDS` and `TOKEN_LAYERS` are **fxyz's reference vocabulary** (currencies,
institutions, corridors, tokens, and so on) — a starting ontology, not a
universal schema. If you model a different domain, fork or extend them; the set
is intentionally closed so a new kind is a deliberate addition, never an ad-hoc
string.

## Relationship to the sibling packages

Everything else builds on this: `@fxyz/graph-engine` ingests `GraphPayloadV1`
and keys identity/selection by `GraphRef`; `@fxyz/graph-layout` keeps its
edge-id grammar byte-compatible with `makeEdgeId`; `@fxyz/graph-algorithms`
result kinds map onto the same visual channels a `LensSpec` declares.
