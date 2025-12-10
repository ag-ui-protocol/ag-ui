/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/*.test.ts"],
  passWithNoTests: true,
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@ag-ui/core$": "<rootDir>/../core/src/index.ts",
    "^@ag-ui/core/(.*)$": "<rootDir>/../core/src/$1",
    "^@ag-ui/proto$": "<rootDir>/../proto/src/index.ts",
    "^@ag-ui/proto/(.*)$": "<rootDir>/../proto/src/$1",
    "^@ag-ui/encoder$": "<rootDir>/../encoder/src/index.ts",
    "^@ag-ui/encoder/(.*)$": "<rootDir>/../encoder/src/$1",
  },
};
