/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/en/configuration.html
 */

// eslint-disable-next-line import/no-anonymous-default-export
export default {
  coverageProvider: 'v8',
  // Force EVERY source file into the coverage denominator. Without this, v8 only
  // reports files a test actually imports, so an untested file silently vanishes
  // from the metric (the 95% gate historically graded ~37% of src while real
  // coverage was ~45%). With collectCoverageFrom, an untested file shows 0% and
  // fails the gate — drift can no longer hide, and coveragePathIgnorePatterns
  // below is the single, reviewable record of intentional exclusions.
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.spec.ts',
    '!src/**/__mocks__/**',
    '!src/**/__tests__/**'
  ],
  // Narrow exclusions only for code that is fundamentally E2E/snapshot
  // territory and has no unit-testable surface:
  //
  // - `app/pages/Browser/` — framer-motion drag handlers / launcher
  //   overlays, exercised by the mobile-e2e suite.
  // - `app/pages/Pending.tsx` / `app/pages/Receive/` — long-lived polling,
  //   QR/native-share UI, and transaction-list interactions covered by E2E.
  // - `app/providers/DappBrowserProvider.tsx` — Capacitor inappbrowser
  //   provider wired to native plugins, exercised via mobile-e2e.
  // - `components/TransactionProgressModal.tsx` — react-modal portal
  //   with framer-motion animation, covered by Playwright.
  // - `components/review/ReviewRow.tsx`, `lib/ui/drawer.tsx`, and the swap
  //   success view — interaction/animation wrappers with no domain logic.
  // - `lib/animation/use-motion.ts` — browser media-query/animation plumbing.
  // - `app/icons/v2/index.tsx` — barrel file of SVG re-exports.
  // - `lib/mobile/faucet-webview.ts` — Capacitor InAppBrowser wrapper.
  // - `packages/dapp-browser/` — external package build output.
  // - `lib/lock-up/run-checks.ts` — extension popup bootstrap with module-scope
  //   top-level `await`; @swc/jest emits bare TLA into a CommonJS wrapper that
  //   won't load, so it has no clean unit surface without a source refactor
  //   (extract the logic out of the bootstrap) or a brittle transformer hack.
  // - `lib/miden/assets/stake.ts` — zero-byte placeholder module: no exports,
  //   not referenced by the `./index` barrel, not imported anywhere. It has no
  //   runtime surface to test; when real staking logic lands, remove it from
  //   this list so the gate demands proper tests.
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/src/lib/lock-up/run-checks\\.ts$',
    '/src/lib/miden/assets/stake\\.ts$',
    '/src/app/pages/Browser/',
    '/src/app/pages/Pending\\.tsx$',
    '/src/app/pages/Receive\\.tsx$',
    '/src/app/pages/Receive/',
    '/src/app/icons/v2/index\\.tsx$',
    '/src/app/providers/DappBrowserProvider\\.tsx$',
    '/src/components/TransactionProgressModal\\.tsx$',
    '/src/components/review/ReviewRow\\.tsx$',
    '/src/lib/animation/use-motion\\.ts$',
    '/src/lib/ui/drawer\\.tsx$',
    '/src/lib/mobile/faucet-webview\\.ts$',
    '/src/screens/generating-transaction/success/SwapSuccess\\.tsx$',
    '/packages/dapp-browser/'
  ],
  // 'json-summary' emits coverage/coverage-summary.json, consumed by the
  // coverage-badge workflow to publish the README shields.io badge.
  coverageReporters: ['json-summary', 'text-summary', 'lcov'],
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
    // Match all four published subpaths — tests mock them identically.
    // - `@miden-sdk/miden-sdk`         (eager + ST)
    // - `@miden-sdk/miden-sdk/lazy`    (lazy + ST)
    // - `@miden-sdk/miden-sdk/mt`      (eager + MT)
    // - `@miden-sdk/miden-sdk/mt/lazy` (lazy + MT)
    '^@miden-sdk/miden-sdk(/lazy|/mt|/mt/lazy)?$': '<rootDir>/__mocks__/wasmMock.js',
    // React SDK now also has /mt and /mt/lazy subpaths matching the
    // underlying SDK's MT variants. Tests mock all four identically.
    '^@miden-sdk/react(/lazy|/mt|/mt/lazy)?$': '<rootDir>/__mocks__/@miden-sdk/react.ts',
    '^@openzeppelin/miden-multisig-client$': '<rootDir>/__mocks__/@openzeppelin/miden-multisig-client.ts',
    '^@openzeppelin/guardian-client$': '<rootDir>/__mocks__/@openzeppelin/guardian-client.ts'
  },
  testEnvironment: 'jsdom',
  transform: {
    '.+\\.(ts|tsx|js|mjs)$': '@swc/jest'
  },
  transformIgnorePatterns: ['/node_modules/(?!(p-queue|p-timeout|eventemitter3|date-fns|dexie)/)'],
  moduleFileExtensions: ['ts', 'tsx', 'js'],
  // Exclude git worktrees: they hold full copies of the repo, so without this a
  // plain `jest` run discovers their stale test files and emits haste-map
  // duplicate-mock collisions (spurious local failures). CI checks out clean, so
  // this only matters for local runs.
  modulePathIgnorePatterns: ['<rootDir>/sdk-debug/', '<rootDir>/.worktrees/', '<rootDir>/.claude/'],
  testPathIgnorePatterns: [
    '<rootDir>/playwright/',
    '<rootDir>/mobile-e2e/',
    '<rootDir>/ios/App/build/',
    '<rootDir>/.worktrees/',
    '<rootDir>/.claude/'
  ],
  setupFiles: ['dotenv/config', '@serh11p/jest-webextension-mock', 'fake-indexeddb/auto'],
  setupFilesAfterEnv: ['./jest.setup.js']
};
