import { createJestConfig } from "../../config/jest/create-jest-config.mjs";

export default createJestConfig({
	testMatch: ["<rootDir>/src/__tests__/**/*.(test|spec).(ts|tsx)"],
	// d3-force-3d and its d3 sub-deps ship ESM-only — swc must transform them.
	esmPackages: [
		"d3-force-3d",
		"d3-binarytree",
		"d3-dispatch",
		"d3-octree",
		"d3-quadtree",
		"d3-timer",
	],
});
