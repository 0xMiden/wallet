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
 * each screen's own suite, named below, where the real component renders. The one exception is
 * `EvmBridgeDepositScreen`, which has no suite of its own; it keeps a source assertion, and that
 * weaker guard is recorded rather than hidden.
 */
const VALUE_SIGNING_SCREENS: ReadonlyArray<{
  screen: string;
  rendersBannerIn: string;
  /** The suite whose render assertion is the real guard, or null when only a source check exists. */
  assertedIn: string | null;
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
  // The connected bridge flow: amount entry and route choice, the steps that commit. It has no
  // suite of its own, so this is the one entry still guarded by source alone.
  {
    screen: 'app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx',
    rendersBannerIn: 'app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx',
    assertedIn: null
  }
];

const read = (relative: string) => readFileSync(join(__dirname, '..', relative), 'utf8');

describe('every screen that commits value names the network', () => {
  it.each(VALUE_SIGNING_SCREENS.filter(s => s.assertedIn !== null))(
    '$screen is guarded by a render assertion in $assertedIn',
    ({ assertedIn }) => {
      // The registry records WHERE the real guard lives. If that assertion is deleted, this fails
      // and says which screen lost its cover, instead of the set quietly shrinking.
      expect(read(assertedIn!)).toContain("getByTestId('network-mode-banner')");
    }
  );

  it.each(VALUE_SIGNING_SCREENS.filter(s => s.assertedIn === null))(
    '$screen has no suite, so its banner is pinned here by source',
    ({ rendersBannerIn }) => {
      const source = read(rendersBannerIn);

      // Tolerates other named imports from the same module: the shell also pulls in
      // `NetworkNamedByShell`, and an exact-line match failed on that rather than on anything real.
      expect(source).toMatch(/import \{[^}]*\bNetworkModeBanner\b[^}]*\} from 'components\/NetworkModeBanner';/);
      expect(source).toContain('<NetworkModeBanner />');
    }
  );

  it.each(VALUE_SIGNING_SCREENS.filter(s => s.screen !== s.rendersBannerIn))(
    '$screen still renders through $rendersBannerIn, which is what carries its banner',
    ({ screen, rendersBannerIn }) => {
      // A screen that stops using the layout loses the banner with it, and its own file would
      // never show that.
      const component = rendersBannerIn.split('/').pop()!.replace('.tsx', '');

      expect(read(screen)).toContain(`<${component}`);
    }
  );

  it('lists every screen exactly once', () => {
    const screens = VALUE_SIGNING_SCREENS.map(s => s.screen);

    expect(new Set(screens).size).toBe(screens.length);
  });
});
