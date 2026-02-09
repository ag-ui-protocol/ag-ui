module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__', '<rootDir>/__mocks__'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  moduleNameMapper: {
    '^@ag-ui/client$': '<rootDir>/__mocks__/@ag-ui/client.ts',
    '^@ag-ui/core$': '<rootDir>/__mocks__/@ag-ui/core.ts',
    '^@anthropic-ai/claude-agent-sdk$': '<rootDir>/__mocks__/@anthropic-ai/claude-agent-sdk.ts',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 40,
      functions: 40,
      lines: 40,
      statements: 40,
    },
  },
};

