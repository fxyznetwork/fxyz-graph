# `@fxyz/graph-algorithms`

A first-class, venue-agnostic algorithm layer. One typed registry where
**FX-style financial algorithms and classic graph algorithms are siblings**
under a single contract:

```ts
run(workingSet, params) => Promise<AlgoResult>
```

Adding an analytic is adding a *row*, not building a pipeline. The package is
pure and dependency-light, so the same registry row can run in the browser over
a loaded working set or server-side over a live graph — *where* it runs is a
per-call `Venue` decision (`deriveVenue`), never a "blocked" capability gate.

## The FX-routing sibling story

The interesting claim is that currency routing and arbitrage detection are just
graph algorithms. Both `cheapest-route` and `negative-cycles` share one weight
convention (`edgeCost`): an explicit `weight`, else `-ln(rate)`. Under that
convention:

- **cheapest route** (Bellman-Ford shortest path) becomes the
  best-compounded FX conversion — `meta.compoundedRate = exp(-totalWeight)`;
- **a negative cycle** (Bellman-Ford cycle detection) becomes an arbitrage
  loop — `meta.gain = exp(-totalWeight)` is the compounded multiplier per lap.

They sit in the same registry as `eigenvector-centrality`, a classic graph
metric, under the same `run()` signature.

## Usage

```ts
import { createDefaultRegistry, deriveVenue } from "@fxyz/graph-algorithms";

const registry = createDefaultRegistry();
const route = registry.get("cheapest-route");

// USD→EUR (0.9) → GBP (0.85) compounds to 0.765 > the direct USD→GBP (0.75).
const graph = {
  nodes: [{ id: "USD" }, { id: "EUR" }, { id: "GBP" }],
  edges: [
    { source: "USD", target: "EUR", properties: { rate: 0.9 } },
    { source: "EUR", target: "GBP", properties: { rate: 0.85 } },
    { source: "USD", target: "GBP", properties: { rate: 0.75 } },
  ],
};

const decision = deriveVenue(route!, graph.nodes.length); // -> { venue: "client-ts", ... }
const result = await route!.run(graph, { source: "USD", target: "GBP" });
// result.paths[0].meta.compoundedRate ≈ 0.765
```

## Key exports

- **Registry**: `AlgorithmRegistry`, `createRegistry`, `createDefaultRegistry`
  (preloaded with the built-ins). An optional injected `RegistrationGuard` can
  gate algorithms that declare a `guardKey` (register only after approval);
  everything else registers freely.
- **Built-in algorithms**: `cheapestRoute`, `negativeCycles`,
  `eigenvectorCentrality`, plus the shared `edgeCost`.
- **Venue resolver**: `deriveVenue` picks the cheapest venue whose size envelope
  fits the working set, and *refuses* (never hangs) when everything is exceeded.
- **Encoding bridge** (`@fxyz/graph-algorithms/contract`): `encodeResult` maps an
  `AlgoResult` (`scores` / `communities` / `paths` / `cycles` / `derived`) onto
  visual channels — the renderer never sees the algorithm, only the result.

## Relationship to the sibling packages

Results feed a renderer through the encoding bridge; the channel names line up
with the style-rule channels a `@fxyz/graph-contract` `LensSpec` declares.
`@fxyz/graph-engine` can drive a backend from those encodings.
