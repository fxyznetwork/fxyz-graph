import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"landing-substrate/index": "src/landing-substrate/index.ts",
		"public-graph-limits": "src/public-graph-limits.ts",
		// Server-only Louvain precompute engine. Its OWN entry — kept out of the
		// `.` barrel so client consumers of @fxyz/graph-layout never pull
		// graphology / neo4j-driver into a bundle.
		"precompute-louvain": "src/precompute-louvain-core.ts",
		// Dep-free edge-cache codec — kept separate so decoding never pulls the
		// engine's deps.
		"workbench-edge-cache": "src/workbench-edge-cache.ts",
	},
	format: ["cjs", "esm"],
	dts: true,
	splitting: true,
	sourcemap: false,
	clean: true,
	external: [
		"react",
		"react-dom",
		"neo4j-driver",
		"d3-force-3d",
		"graphology",
		"graphology-communities-louvain",
	],
});
