# `@repo/graph-layout`

Server-side **layout + data** for the Neo4j canon graph. Surfaces query the
substrate through this package and get back a typed, redaction-filtered slice
with force-directed positions and community structure. It is **not** a renderer —
the actual rendering lives in `@repo/visualization` and `apps/web`'s landing
(`landing-vnext`). (Renamed from `@repo/substrate-render` 2026-06-05; the old
`SubstrateRender` text-list viewer + its `/substrate-preview` dev surface were
removed in the same pass.)

## Premise

The Neo4j graph IS canon (per `docs/canon/CANON.md`). Surfaces query the
substrate; they don't repeat canon prose. This package produces the data that
the renderers compose.

## Exports

- **`@repo/graph-layout/source`** — server-only. Runs Cypher against prod and
  returns a typed substrate slice (`fetchPublicSubstrate`). Always
  redaction-filtered (no `redactionFlag` content, no PII, no zero-geo
  identifiers).
- **`@repo/graph-layout/landing-substrate`** — builds the landing slice
  (`buildLandingSlice`): d3-force-3d positioning + Louvain community detection
  over the public slice, returning a `LandingSubstrateSlice` for the landing
  scene to render.
- **root (`@repo/graph-layout`)** — the shared data schema only
  (`SubstrateData` / `SubstrateNode` / `SubstrateEdge` + canon enums).

## Consumers

| Consumer | Import |
|---|---|
| `apps/api` landing + public substrate routes | `fetchPublicSubstrate` from `/source` |
| `apps/api/app/api/landing/substrate` | `buildLandingSlice` from `/landing-substrate` |
| `apps/web` landing scene + `@repo/visualization` | `LandingSubstrateSlice` type from `/landing-substrate`; `SubstrateNode`/`SubstrateNodeKind` from root |

## Hard rules

- **`redactionFlag` content NEVER renders** (internal-DNA Concepts in prod)
- **PII NEVER renders** (no DIDs, real names, real emails)
- **Zero-geo identifiers filtered** (per `feedback-zero-geo-identifiers`)
- **Math glyphs as headlines disallowed** in any surface that consumes this data
- **Wordmark `ƒxyz` is the only fixed mark**
