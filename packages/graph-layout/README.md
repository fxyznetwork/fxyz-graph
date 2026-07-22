# `@fxyz/graph-layout`

Layout and data-shaping helpers for a caller-supplied graph dataset. Pure
functions over an in-memory graph — nothing here talks to a database or a
renderer. It does two things:

- **Client-side lenses** (root export) that recolour an already-loaded graph by
  a structural property (Louvain communities, k-core core/periphery).
- **A landing-slice builder** (`./landing-substrate` subpath) that turns a
  plain node/edge dataset into a positioned, community-tagged slice ready for a
  hero/landing-style rendering surface.

It depends on `d3-force-3d`, `graphology`, and `graphology-communities-louvain`.
`react`/`react-dom` are optional peer dependencies (only needed if a consumer
wires the output into React components).

## Exports

### Root — `@fxyz/graph-layout`

The shared in-memory graph schema plus the colour lenses.

- **Schema types**: `SubstrateData` (`{ nodes, edges, meta }`), `SubstrateNode`,
  `SubstrateEdge`, `SubstrateNodeKind`, `SubstrateEdgeKind`, `SubstrateMeta`,
  `SubstratePerspective`. A generic nodes + edges + meta shape; the node/edge
  kinds are the reference vocabulary this library ships (a finance/knowledge
  graph), but the layout and lens helpers only rely on `id`, `kind`, and
  endpoint references, so you can supply your own kind strings.
- **Lenses**: `computeLensColors(lens, nodes, links, theme?)` returns a
  `Map<nodeId, hex>` a renderer can apply as per-node colour overrides. Lenses:
  `"communities"` (Louvain) and `"core-periphery"` (k-core). Helpers:
  `communitiesPartitionStats`, `isTrivialCommunityPartition`, plus the shared
  palettes `COMMUNITY_PALETTE`, `CORE_HEX`, `PERIPHERY_HEX`.

```ts
import { computeLensColors } from "@fxyz/graph-layout";

const nodes = [{ id: "a1" }, { id: "a2" }, { id: "b1" }];
const links = [
  { source: "a1", target: "a2" },
  { source: "a2", target: "b1" },
];
const colors = computeLensColors("communities", nodes, links, "dark");
// colors.get("a1") -> "#..."  (one palette hue per detected community)
```

### `@fxyz/graph-layout/landing-substrate`

`buildLandingSlice(data, options?)` runs, in one pass:

1. two-pass community detection (group by kind, Louvain sub-partition),
2. deterministic 3D force-directed positioning with community cohesion,
3. a deterministic 2D "close" layout for a 3D→2D crossfade,

and returns a `LandingSubstrateSlice` (`PositionedNode[]` + `communities` +
`nodeCommunity`). It is a pure function and stable across runs for the same
input (positions are seeded from node-id hashes), so it is cheap to run
server-side and cache.

```ts
import { buildLandingSlice } from "@fxyz/graph-layout/landing-substrate";

const slice = buildLandingSlice({
  nodes: [
    { id: "usd", kind: "Currency", label: "US Dollar" },
    { id: "eur", kind: "Currency", label: "Euro" },
  ],
  edges: [{ id: "e1", source: "usd", target: "eur", kind: "USES_CURRENCY" }],
  meta: { fetchedAt: new Date().toISOString(), sliceTag: "demo", counts: {} },
});

// slice.nodes[0] -> { id, kind, x, y, z, communityId, tone, close2d? }
```

The lower-level pieces (`runForceLayout`, `runCloseLayout2d`, `detectCommunities`)
are exported too if you want to compose them yourself.

## Relationship to the sibling packages

- **`@fxyz/graph-contract`** — the shared identity/payload contract. Used here
  only as a dev dependency, to keep `graph-layout`'s edge-id grammar
  byte-compatible with the contract's `makeEdgeId`. There is no runtime dependency.
- **`@fxyz/graph-engine`** — the headless controller. It can render a slice or
  lens output this package produces, but neither package imports the other.
