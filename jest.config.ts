/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/en/configuration.html
 */

// eslint-disable-next-line import/no-anonymous-default-export
export default {
  coverageProvider: 'v8',
  // Exclude the mobile-only dApp browser surface from coverage. These
  // files are React components + providers that orchestrate native
  // InAppBrowser plugin calls (park/restore/snapshot/confirmation
  // modal, native navbar overlay, multi-instance lifecycle). Unit
  // testing them meaningfully requires driving the native side,
  // which is covered by the mobile-e2e suite rather than Jest.
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/src/app/pages/Browser/',
    '/src/app/providers/DappBrowserProvider\\.tsx$',
    '/src/lib/dapp-browser/',
    '/src/lib/mobile/faucet-webview\\.ts$'
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60
    }
  },
  moduleNameMapper: {
    // Asset stubs must come BEFORE the `^app/` / `^lib/` path mappers so
    // `import icon from 'app/misc/dapp-icons/foo.png'` resolves to the
    // stub instead of trying to execute the PNG bytes as JavaScript.
    '\\.svg$': '<rootDir>/__mocks__/svgMock.js',
    '\\.(png|jpg|jpeg|gif|webp)$': '<rootDir>/__mocks__/fileMock.js',
    '^lib/(.*)$': '<rootDir>/src/lib/$1',
    '^shared/(.*)$': '<rootDir>/src/shared/$1',
    '^app/(.*)$': '<rootDir>/src/app/$1',
    '^components/(.*)$': '<rootDir>/src/components/$1',
    '^screens/(.*)$': '<rootDir>/src/screens/$1',
    '^utils/(.*)$': '<rootDir>/src/utils/$1',
    '@miden-sdk/miden-sdk': '<rootDir>/__mocks__/wasmMock.js'
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
  testPathIgnorePatterns: ['<rootDir>/playwright/', '<rootDir>/mobile-e2e/'],
  setupFiles: ['dotenv/config', '@serh11p/jest-webextension-mock', 'fake-indexeddb/auto'],
  setupFilesAfterEnv: ['./jest.setup.js']
};
