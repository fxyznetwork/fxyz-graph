const baseSwcTransform = [
	"@swc/jest",
	{
		sourceMaps: "inline",
		module: {
			type: "commonjs",
		},
		jsc: {
			target: "es2022",
			parser: {
				syntax: "typescript",
				tsx: true,
				decorators: true,
				dynamicImport: true,
			},
			transform: {
				react: {
					runtime: "automatic",
				},
			},
		},
	},
];

function escapeForRegex(value) {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function buildTransformIgnorePatterns(esmPackages = []) {
	if (esmPackages.length === 0) {
		return ["node_modules/"];
	}

	// pnpm stores packages at node_modules/.pnpm/<name>+<ver>/node_modules/<name>/
	// We need to match both direct paths AND .pnpm nested paths
	const allowlist = esmPackages.map(escapeForRegex).join("|");
	return [
		`node_modules/(?!\\.pnpm/.+/node_modules/(${allowlist})/|(${allowlist})/)`,
	];
}

function mergeUnique(values) {
	return [...new Set(values)];
}

const defaultModuleNameMapper = {
	"^(\\.{1,2}/.*)\\.js$": "$1",
};

/**
 * Shared jest config factory for this workspace's packages. Each package's
 * jest.config.js imports this and passes its own testMatch / esmPackages /
 * overrides.
 */
export function createJestConfig({
	testEnvironment = "node",
	setupFiles,
	setupFilesAfterEnv,
	moduleNameMapper,
	testMatch,
	testPathIgnorePatterns,
	transformIgnorePatterns,
	esmPackages,
	collectCoverageFrom,
	clearMocks,
	testTimeout,
	extraConfig,
} = {}) {
	return {
		testEnvironment,
		moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
		transform: {
			"^.+\\.(t|j)sx?$": baseSwcTransform,
		},
		transformIgnorePatterns:
			transformIgnorePatterns ?? buildTransformIgnorePatterns(esmPackages),
		testPathIgnorePatterns: mergeUnique([
			"/node_modules/",
			"/dist/",
			...(testPathIgnorePatterns ?? []),
		]),
		...(setupFiles ? { setupFiles } : {}),
		...(setupFilesAfterEnv ? { setupFilesAfterEnv } : {}),
		...(moduleNameMapper
			? { moduleNameMapper: { ...defaultModuleNameMapper, ...moduleNameMapper } }
			: { moduleNameMapper: defaultModuleNameMapper }),
		...(testMatch ? { testMatch } : {}),
		...(collectCoverageFrom ? { collectCoverageFrom } : {}),
		...(clearMocks ? { clearMocks } : {}),
		...(testTimeout ? { testTimeout } : {}),
		...(extraConfig ?? {}),
	};
}
