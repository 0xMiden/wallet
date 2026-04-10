/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/en/configuration.html
 */

// eslint-disable-next-line import/no-anonymous-default-export
export default {
  coverageProvider: 'v8',
  // Narrow exclusions only for code that is fundamentally E2E/snapshot
  // territory and has no unit-testable surface:
  //
  // - `app/pages/Browser/` — framer-motion drag handlers / launcher
  //   overlays, exercised by the mobile-e2e suite.
  // - `app/pages/Receive.tsx` — QR canvas + long UI, E2E territory.
  // - `app/providers/DappBrowserProvider.tsx` — Capacitor inappbrowser
  //   provider wired to native plugins, exercised via mobile-e2e.
  // - `components/TransactionProgressModal.tsx` — react-modal portal
  //   with framer-motion animation, covered by Playwright.
  // - `app/icons/v2/index.tsx` — barrel file of SVG re-exports.
  // - `lib/mobile/faucet-webview.ts` — Capacitor InAppBrowser wrapper.
  // - `packages/dapp-browser/` — external package build output.
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/src/app/pages/Browser/',
    '/src/app/pages/Receive\\.tsx$',
    '/src/app/icons/v2/index\\.tsx$',
    '/src/app/providers/DappBrowserProvider\\.tsx$',
    '/src/components/TransactionProgressModal\\.tsx$',
    '/src/lib/mobile/faucet-webview\\.ts$',
    '/packages/dapp-browser/'
  ],
  coverageThreshold: {
    global: {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95
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
    '@miden-sdk/miden-sdk': '<rootDir>/__mocks__/wasmMock.js',
    '@miden-sdk/react': '<rootDir>/__mocks__/@miden-sdk/react.ts'
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
