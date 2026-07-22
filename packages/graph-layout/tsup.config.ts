import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"landing-substrate/index": "src/landing-substrate/index.ts",
	},
	format: ["cjs", "esm"],
	dts: true,
	splitting: true,
	sourcemap: false,
	clean: true,
	external: [
		"react",
		"react-dom",
		"d3-force-3d",
		"graphology",
		"graphology-communities-louvain",
	],
});
