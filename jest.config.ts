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
  // - `components/review/ReviewRow.tsx`, `lib/ui/drawer.tsx`, and the swap
  //   success view — interaction/animation wrappers with no domain logic.
  // - `lib/animation/use-motion.ts` — browser media-query/animation plumbing.
  // - `app/icons/v2/index.tsx` — barrel file of SVG re-exports.
  // - `lib/mobile/faucet-webview.ts` — Capacitor InAppBrowser wrapper.
  // - `app/pages/BridgeDeposit.tsx`, `app/templates/EvmConnectModal*`, and
  //   `lib/{epoch,agglayer,walletconnect}/` — external wallet/intent SDK and
  //   native-provider orchestration exercised by the bridge Playwright suites.
  // - `lib/miden/activity/bridge-in.ts` — persistent bridge-intent polling and
  //   transaction reconciliation, covered by the end-to-end deposit flow.
  // - `lib/miden/swap/test-hooks.ts` — E2E-only window hooks, not production
  //   application behavior.
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
    '/src/app/pages/PendingNotes\\.tsx$',
    '/src/app/pages/BridgeDeposit\\.tsx$',
    '/src/app/templates/EvmConnectModal',
    // Bridged-send activity-detail claim/reclaim panel — the same external
    // wallet + agglayer/epoch-SDK orchestration as the entries above, exercised
    // by the bridge Playwright suites. Its critical reclaim/claim logic has
    // focused unit tests (BridgeClaimSection.test.tsx), but its many
    // wallet-state / poll-timing branches are E2E territory.
    '/src/app/templates/history/BridgeClaimSection\\.tsx$',
    '/src/app/pages/Receive\\.tsx$',
    '/src/app/pages/Receive/',
    '/src/app/icons/v2/index\\.tsx$',
    '/src/app/providers/DappBrowserProvider\\.tsx$',
    '/src/components/review/ReviewRow\\.tsx$',
    '/src/lib/animation/use-motion\\.ts$',
    '/src/lib/ui/drawer\\.tsx$',
    '/src/lib/mobile/faucet-webview\\.ts$',
    '/src/lib/epoch/',
    '/src/lib/agglayer/',
    '/src/lib/walletconnect/',
    '/src/lib/miden/activity/bridge-in\\.ts$',
    // E2E-only `globalThis`/`window` __TEST_* hooks, MIDEN_E2E_TEST-gated and
    // dead-stripped from production — no unit-testable surface (same rationale as
    // swap/test-hooks.ts). earn-test-hooks + bridge-in-test-hooks were an
    // oversight, not excluded when swap's were.
    '/src/lib/miden/activity/bridge-in-test-hooks\\.ts$',
    '/src/lib/miden/activity/earn-test-hooks\\.ts$',
    '/src/lib/miden/swap/test-hooks\\.ts$',
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
    '\\.(css|less|scss|sass)$': '<rootDir>/__mocks__/styleMock.ts',
    '^lib/(.*)$': '<rootDir>/src/lib/$1',
    '^shared/(.*)$': '<rootDir>/src/shared/$1',
    '^app/(.*)$': '<rootDir>/src/app/$1',
    '^components/(.*)$': '<rootDir>/src/components/$1',
    '^screens/(.*)$': '<rootDir>/src/screens/$1',
    '^utils/(.*)$': '<rootDir>/src/utils/$1',
    '^@reown/appkit/react$': '<rootDir>/__mocks__/reownAppKitReact.ts',
    '^@reown/appkit/networks$': '<rootDir>/__mocks__/reownAppKitNetworks.ts',
    '^@reown/appkit-adapter-wagmi$': '<rootDir>/__mocks__/reownWagmiAdapter.ts',
    '^@wagmi/core$': '<rootDir>/__mocks__/wagmiCore.ts',
    '^wagmi$': '<rootDir>/__mocks__/wagmi.ts',
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
  // The wallet-adapter packages publish only a `module` field pointing at an
  // ESM bundle — no `main`, no `exports` — so CommonJS cannot load them and
  // every test mocks them instead. `conformance.test.ts` is the one test that
  // must load the REAL package, so it needs @swc/jest to transpile it; without
  // this entry that `require` dies on `Unexpected token 'export'`, the suite
  // catches it and skips, and it would keep skipping through every future
  // adapter release while reporting the reason as a missing export.
  transformIgnorePatterns: [
    '/node_modules/(?!(p-queue|p-timeout|eventemitter3|date-fns|dexie|@epoch-protocol|@wagmi|wagmi|@reown|@miden-sdk/miden-wallet-adapter-base|@miden-sdk/miden-wallet-adapter-miden)/)'
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js'],
  // Exclude git worktrees: they hold full copies of the repo, so without this a
  // plain `jest` run discovers their stale test files and emits haste-map
  // duplicate-mock collisions (spurious local failures). CI checks out clean, so
  // this only matters for local runs.
  modulePathIgnorePatterns: ['<rootDir>/sdk-debug/', '<rootDir>/.worktrees/', '<rootDir>/.claude/'],
  testPathIgnorePatterns: [
    // Playwright's own *.spec.ts e2e suites (and every other file under
    // playwright/) stay out of the Jest run — only pure-unit *.test.ts files
    // living under playwright/ (e.g. playwright/e2e/harness/*.test.ts) are
    // let through, via the negative lookahead, so harness helpers can get
    // ordinary Jest unit-test coverage without dragging live-network e2e
    // specs (which use Playwright's own `test`/`expect` globals) into Jest.
    '<rootDir>/playwright/(?!.*\\.test\\.ts$)',
    '<rootDir>/mobile-e2e/',
    '<rootDir>/ios/App/build/',
    '<rootDir>/.worktrees/',
    '<rootDir>/.claude/'
  ],
  setupFiles: ['dotenv/config', '@serh11p/jest-webextension-mock', 'fake-indexeddb/auto'],
  setupFilesAfterEnv: ['./jest.setup.js']
};
