import { createJestConfig } from "../../config/jest/create-jest-config.mjs";

export default createJestConfig({
	testMatch: ["<rootDir>/src/__tests__/**/*.(test|spec).(ts|tsx)"],
});
