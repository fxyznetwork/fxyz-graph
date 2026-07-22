# `@fxyz/graph-engine`

The headless graph controller. It ingests a `@fxyz/graph-contract`
`GraphPayloadV1` and drives a **swappable rendering backend** through an
observable-API contract — the engine itself renders nothing. Its job is to make
the hard interaction guarantees structural rather than hoped-for.

## What it does

- **Incremental ingest → diff → apply.** One backend instance per engine,
  constructed ONCE. A data change never reconstructs it; a lens/filter change
  never reconstructs it; the config is frozen at construction.
- **Server-positions-first layout.** Payloads that carry positions render under
  `free`; a client force-sim is an explicit small-graph opt-in below a measured
  budget, and anything larger without positions is a hard error, never a silent
  client scatter.
- **Id-keyed identity** — `PositionStore` / `SelectionStore` key by `GraphRef`,
  so positions and selection join across tiers and refetches.
- **Budgeted, throttled interaction** — a spatial index (`SpatialGrid`) plus a
  `throttle`, and a top-N label budget (`pickLabeledNodes`) independent of graph
  size.
- **A lens/styling runtime** with incremental deltas (`applyStyleRules`,
  `diffStylePatches`).

Renderers are **backends**. A stub backend ships in this package; an adapter for
a real rendering library is wired via an injected instance factory
(`createNvlBackendFactory`), and other renderers slot in behind the same
`GraphBackend` contract. Optional React bindings (`@fxyz/graph-engine/react`)
provide a `GraphPane` component.

A suite of interaction-invariant acceptance tests ships in this package —
features come after invariants.

## Usage

```ts
import { GraphEngine, createStubBackend } from "@fxyz/graph-engine";
import { buildPayload, makeRef } from "@fxyz/graph-contract";

const engine = new GraphEngine(createStubBackend, {
  container: null,          // an HTMLElement in a real mount
  renderer: "webgl",
  layout: "free",
  disableTelemetry: true,   // required, at the type level
});

const eur = makeRef("currency", "EUR");
engine.ingest(
  buildPayload({
    audience: "member", tier: "panel", lens: "raw", scope: "test",
    dataVersion: "dv1", aclVersion: "acl1",
    nodes: [{ id: eur, kind: "currency", label: "Euro", x: 0, y: 0, provenance: "real", measures: { degree: 3 } }],
    edges: [],
    coverage: { framing: "curated" }, sampled: false, positionsIncluded: true,
  }),
);

engine.applyLens([{ source: "degree", channel: "size" }]); // incremental — no reconstruction
engine.select([eur]);
```

## Key exports

- **Controller**: `GraphEngine`, `EngineViolation`.
- **Backends**: `createStubBackend` / `StubBackend`, `createNvlBackendFactory` /
  `NvlBackend`, and the `GraphBackend` contract types (`BackendNode`,
  `BackendRel`, `BackendConstructOptions`, `assertTelemetryDisabled`).
- **Identity + interaction**: `PositionStore`, `SelectionStore`, `SpatialGrid`,
  `throttle`, `pickLabeledNodes`.
- **Layout + lens**: `resolveLayout`, `DEFAULT_LAYOUT_POLICY`, `applyStyleRules`,
  `diffStylePatches`, `COMMUNITY_PALETTE`, `applyDataUpdate`, `computeElementDiff`.
- **React** (`@fxyz/graph-engine/react`): `GraphPane` and helpers.

## Relationship to the sibling packages

`@fxyz/graph-engine` depends only on `@fxyz/graph-contract` for identity and
payloads. It consumes positioned data from `@fxyz/graph-layout` and result
encodings from `@fxyz/graph-algorithms`, but does not import either — everything
crosses the contract boundary.
