import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Before #875's follow-up, `<NetworkModeBanner />` sat in one slot in `PageRouter` under the
 * comment "sits above EVERY routed page ... so no screen can forget it". That slot was removed in
 * favour of a corner ribbon in the tab bar, and the ribbon reaches only tab pages - so every
 * screen that commits value silently stopped naming the network, with no test failing.
 *
 * These are the screens on which the user commits value. They span three shells and share no
 * wrapper: five full-screen routes render the banner themselves, two render inside `TabLayout`
 * through `ReviewLayout` - where the ribbon is HIDDEN, because that layout hides the tab-bar
 * footer the ribbon lives in - and the connected EVM bridge flow renders it in its own shell on
 * every step except the review one, which `ReviewLayout` already covers.
 *
 * WHAT THIS FILE IS, and what it is not. It is the written registry: the list below is the only
 * place the set is enumerated, and a new signing screen has to be added here by hand, because the
 * seven share no marker a search could key on - not a base component, not a naming convention
 * (`BridgeDeposit` carries no "Review"), and four of them call no transaction hook at all.
 *
 * It no longer asserts the banner's PRESENCE, because a source-text match cannot tell a rendered
 * banner from one behind a falsy guard or below an early return - which is exactly how the
 * connected bridge flow shipped without one while this file stayed green. Presence is asserted by
 * each screen's own suite, named below, where the real component renders. This file checks that
 * the assertion is there and that the suite does not replace the banner, or the layout that
 * carries it, with a mock. A skipped assertion is not checked here: `yarn lint` fails it
 * (`jest/no-disabled-tests` under `--max-warnings 0`).
 */
const VALUE_SIGNING_SCREENS: ReadonlyArray<{
  screen: string;
  rendersBannerIn: string;
  /** The suite whose render assertion is the real guard. */
  assertedIn: string;
}> = [
  {
    screen: 'screens/send-flow/ReviewTransaction.tsx',
    rendersBannerIn: 'screens/send-flow/ReviewTransaction.tsx',
    assertedIn: 'screens/send-flow/ReviewTransaction.test.tsx'
  },
  {
    screen: 'app/pages/RotateGuardianReview.tsx',
    rendersBannerIn: 'app/pages/RotateGuardianReview.tsx',
    assertedIn: 'app/pages/RotateGuardianReview.test.tsx'
  },
  {
    screen: 'app/pages/BridgeDeposit.tsx',
    rendersBannerIn: 'app/pages/BridgeDeposit.tsx',
    assertedIn: 'app/pages/BridgeDeposit.test.tsx'
  },
  {
    screen: 'screens/earn-flow/EarnDepositReview.tsx',
    rendersBannerIn: 'screens/earn-flow/EarnDepositReview.tsx',
    assertedIn: 'screens/earn-flow/EarnDepositReview.test.tsx'
  },
  {
    screen: 'screens/earn-flow/EarnWithdrawReview.tsx',
    rendersBannerIn: 'screens/earn-flow/EarnWithdrawReview.tsx',
    assertedIn: 'screens/earn-flow/EarnWithdrawReview.test.tsx'
  },
  // These two render inside TabLayout via ReviewLayout, which carries the banner for both.
  {
    screen: 'screens/swap-flow/ReviewSwap.tsx',
    rendersBannerIn: 'components/review/ReviewLayout.tsx',
    assertedIn: 'screens/swap-flow/ReviewSwap.test.tsx'
  },
  {
    screen: 'app/templates/EvmConnectModal/EvmBridgeDepositReview.tsx',
    rendersBannerIn: 'components/review/ReviewLayout.tsx',
    assertedIn: 'app/templates/EvmConnectModal/EvmBridgeDepositReview.test.tsx'
  },
  // The connected bridge flow: amount entry and route choice, the steps that commit.
  {
    screen: 'app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx',
    rendersBannerIn: 'app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx',
    assertedIn: 'app/templates/EvmConnectModal/EvmBridgeDepositScreen.deposit.test.tsx'
  }
];

const read = (relative: string) => readFileSync(join(__dirname, '..', relative), 'utf8');

/** A module specifier's last segment without its extension: 'components/review/ReviewLayout.tsx' is 'ReviewLayout'. */
const moduleName = (specifier: string) =>
  specifier
    .split('/')
    .pop()!
    .replace(/\.[jt]sx?$/, '');

/** The modules a suite replaces with jest.mock or jest.doMock, by name, however the path is spelled. */
const mockedModules = (source: string) =>
  [...source.matchAll(/jest\.(?:mock|doMock)\(\s*(['"`])([^'"`]+)\1/g)].map(match => moduleName(match[2]!));

describe('every screen that commits value names the network', () => {
  it.each(VALUE_SIGNING_SCREENS)('$screen is guarded by a render assertion in $assertedIn', ({ assertedIn }) => {
    // The registry records WHERE the real guard lives. If that assertion is deleted, this fails
    // and says which screen lost its cover, instead of the set quietly shrinking.
    expect(read(assertedIn)).toContain("getByTestId('network-mode-banner')");
  });

  it.each(VALUE_SIGNING_SCREENS)(
    '$assertedIn renders the real banner for $screen, not a stub',
    ({ rendersBannerIn, assertedIn }) => {
      // A stand-in that renders the test id keeps the assertion green while the real component never
      // renders. Stubbing the layout that carries the banner is the same hole one level up.
      const mocked = mockedModules(read(assertedIn));

      expect(mocked).not.toContain('NetworkModeBanner');
      expect(mocked).not.toContain(moduleName(rendersBannerIn));
    }
  );

  it.each(VALUE_SIGNING_SCREENS.filter(s => s.screen !== s.rendersBannerIn))(
    '$screen still renders through $rendersBannerIn, which is what carries its banner',
    ({ screen, rendersBannerIn }) => {
      // A screen that stops using the layout loses the banner with it, and its own file would
      // never show that.
      expect(read(screen)).toContain(`<${moduleName(rendersBannerIn)}`);
    }
  );

  it('lists every screen exactly once', () => {
    const screens = VALUE_SIGNING_SCREENS.map(s => s.screen);

    expect(new Set(screens).size).toBe(screens.length);
  });
});

describe('mockedModules', () => {
  it.each([
    ["jest.mock('components/NetworkModeBanner', () => ({}));", 'NetworkModeBanner'],
    ["jest.mock('../../components/NetworkModeBanner', () => ({}));", 'NetworkModeBanner'],
    ["jest.mock('components/NetworkModeBanner.tsx');", 'NetworkModeBanner'],
    ['jest.doMock("components/review/ReviewLayout", () => ({}));', 'ReviewLayout'],
    ['jest.mock(\n  `./ReviewLayout`,\n  () => ({})\n);', 'ReviewLayout']
  ])('reads %j as a mock of %s', (source, name) => {
    expect(mockedModules(source)).toEqual([name]);
  });

  it('reads nothing from a suite that mocks nothing', () => {
    expect(mockedModules("import { NetworkModeBanner } from 'components/NetworkModeBanner';")).toEqual([]);
  });
});
