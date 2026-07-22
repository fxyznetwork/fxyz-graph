import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		contract: "src/contract.ts",
	},
	format: ["cjs", "esm"],
	dts: true,
	splitting: true,
	sourcemap: false,
	clean: true,
});
