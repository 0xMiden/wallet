/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/en/configuration.html
 */

// eslint-disable-next-line import/no-anonymous-default-export
export default {
  coverageProvider: 'v8',
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  moduleNameMapper: {
    '^lib/(.*)$': '<rootDir>/src/lib/$1',
    '^shared/(.*)$': '<rootDir>/src/shared/$1',
    '^app/(.*)$': '<rootDir>/src/app/$1',
    '^components/(.*)$': '<rootDir>/src/components/$1',
    '^screens/(.*)$': '<rootDir>/src/screens/$1',
    '^utils/(.*)$': '<rootDir>/src/utils/$1',
    '@miden-sdk/miden-sdk': '<rootDir>/__mocks__/wasmMock.js',
    '\\.svg$': '<rootDir>/__mocks__/svgMock.js'
  },
  testEnvironment: 'jsdom',
  transform: {
    '.+\\.(ts|tsx|js|mjs)$': '@swc/jest'
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(p-queue|p-timeout|eventemitter3|date-fns|dexie)/)'
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js'],
  modulePathIgnorePatterns: ['<rootDir>/sdk-debug/'],
  testPathIgnorePatterns: ['<rootDir>/playwright/', '<rootDir>/mobile-e2e/', '<rootDir>/stress-test/'],
  setupFiles: ['dotenv/config', '@serh11p/jest-webextension-mock', 'fake-indexeddb/auto'],
  setupFilesAfterEnv: ['./jest.setup.js']
};
