/**
 * The dApp-browser user journey, shared by the iOS and Android suites.
 *
 * One journey rather than nine independent tests: the interesting failures in
 * this feature are all *stateful* — a tile that renders correctly on a clean
 * launcher but not after two sessions have been parked, a restore that works
 * the first time and paints stale content the second. Splitting it into
 * isolated tests would reset exactly the state that makes the bugs appear.
 * Granularity comes from `steps.step(...)`, which the other suites already use
 * and which reports each phase separately on failure.
 *
 * Every transition is a real tap on a real element. The only out-of-band reads
 * are the provider's read-only observability hook (what the wallet believes)
 * and the fixture server's reports (what the dApp page actually laid out at) —
 * two independent sources, so a bug in one can't quietly validate the other.
 */

import { expect } from '@playwright/test';

import type { DappBrowserDriver } from './dapp-browser-driver';
import type { DappFixtureServer } from './dapp-fixture-server';

/** Minimal shape of the `steps` fixture the mobile suites provide. */
export interface StepRunner {
  readonly outputDir: string;
  step(name: string, fn: () => Promise<void>): Promise<void>;
}

export interface DappJourneyOpts {
  driver: DappBrowserDriver;
  server: DappFixtureServer;
  steps: StepRunner;
}

/**
 * Drive the full dApp-browser journey.
 *
 * Sequence mirrors what a user actually does: open something, park it, bring it
 * back, stack a second and third session, move between them, leave the tab and
 * come back, then tidy up.
 */
export async function runDappBrowserJourney({ driver, server, steps }: DappJourneyOpts): Promise<void> {
  await steps.step('launcher_renders_curated_grid', async () => {
    await driver.gotoBrowserTab();
    // The curated grid is real product content (featured-dapps.ts). We assert it
    // renders tiles without opening one — opening a live third-party dApp would
    // put a third party's uptime on this suite's critical path.
    // The curated grid is EXPLORE_GRID_DAPPS — the two faucet dApps — not the
    // whole FEATURED_DAPPS list, and it is a different component from the
    // recents row (only the latter renders `DappTile`). Assert the count the
    // product actually ships plus a real URL per card: a grid that fails to
    // render gives 0, and a card wired up wrong gives an empty href, so this
    // stays falsifiable without breaking when a third card is added.
    const gridUrls = await driver.gridCardUrls();
    expect(gridUrls.length, 'the launcher should render the curated dApp grid').toBeGreaterThanOrEqual(2);
    for (const url of gridUrls) {
      expect(url, 'every curated grid card should carry its dApp URL').toMatch(/^https?:\/\//);
    }
    const state = await driver.state();
    expect(state.sessions, 'no dApp sessions should exist on a fresh launcher').toHaveLength(0);
    expect(state.foregroundId).toBeNull();
  });

  await steps.step('open_custom_url_dapp_alpha', async () => {
    await driver.openViaUrlBar('alpha');
    expect(server.loadCount('alpha'), 'alpha should have been fetched exactly once').toBe(1);
    const fg = await driver.foregroundSession();
    expect(fg?.url, 'alpha should be the foreground session').toBe(server.urlFor('alpha'));
    expect(fg?.error, 'alpha should have loaded without error').toBeNull();
  });

  await steps.step('alpha_is_painted_and_fills_its_slot', async () => {
    await driver.expectDappPainted('alpha', 'alpha-foreground');
    await driver.expectRelayoutMatchesSlot('alpha', 'alpha-initial-layout');
  });

  await steps.step('minimize_alpha_shows_peek_tile', async () => {
    await driver.minimize();
    const cards = await driver.peekCards();
    expect(
      cards.map(c => c.url),
      'the parked dApp should appear as a peek tile'
    ).toContain(server.urlFor('alpha'));

    // The tile renders a snapshot of the parked page. An empty white card here
    // means the snapshot pipeline broke — visible to a user, invisible to the DOM.
    // Compare against the card's real layout constants (CARD_WIDTH 104 /
    // CARD_HEIGHT 132 in DappPeekCard). A collapsed or clipped tile lands well
    // under these; `> 0` would pass on a 1px sliver.
    const card = cards.find(c => c.url === server.urlFor('alpha'))!;
    expect(card.rect.width, 'the peek tile should be laid out at its designed width').toBeGreaterThanOrEqual(80);
    expect(card.rect.height, 'the peek tile should be laid out at its designed height').toBeGreaterThanOrEqual(100);
    await driver.expectRegionNotBlank(card.rect, 'alpha-peek-tile');
  });

  await steps.step('maximize_alpha_rerenders_at_full_size', async () => {
    await driver.restoreViaPeekCard('alpha');
    // The bug this suite was written to catch: the native frame is resized back
    // to the full slot, but the page inside keeps the layout it had before —
    // so the wallet and the dApp disagree about how big the dApp is.
    await driver.expectRelayoutMatchesSlot('alpha', 'alpha-after-maximize');
    await driver.expectDappPainted('alpha', 'alpha-maximized');
    // Re-laying-out and actually PRESENTING the new frame are different things;
    // this is the one that catches "maximize shows the pre-minimize frame".
    await driver.expectFreshFrame('alpha', 'alpha-maximized');
  });

  await steps.step('open_second_dapp_beta_parks_alpha', async () => {
    await driver.minimize();
    await driver.gotoBrowserTab();
    await driver.openViaUrlBar('beta');

    const state = await driver.state();
    expect(state.sessions, 'both sessions should be live').toHaveLength(2);
    const alpha = state.sessions.find(s => s.url === server.urlFor('alpha'));
    expect(alpha?.status, 'alpha should still be parked while beta is foreground').toBe('parked');
    await driver.expectDappPainted('beta', 'beta-foreground');
  });

  await steps.step('switch_back_to_alpha_via_peek_tile', async () => {
    await driver.restoreViaPeekCard('alpha');
    const fg = await driver.foregroundSession();
    expect(fg?.url, 'alpha should be foreground again').toBe(server.urlFor('alpha'));

    // Switching must show ALPHA, not a stale frame of beta. The colour check is
    // the only thing that can tell those apart — both are "a dApp is visible".
    await driver.expectDappPainted('alpha', 'alpha-after-switch');
    await driver.expectRelayoutMatchesSlot('alpha', 'alpha-after-switch-layout');

    const state = await driver.state();
    const beta = state.sessions.find(s => s.url === server.urlFor('beta'));
    expect(beta?.status, 'beta should have been parked by the switch').toBe('parked');
  });

  await steps.step('open_third_dapp_from_a_tile', async () => {
    await driver.minimize();
    await driver.gotoBrowserTab();
    // Opening gamma by URL first records it in Recents, which renders a real
    // `DappTile`. Tapping that tile exercises the tile path with a deterministic
    // target — the same component the curated grid uses.
    await driver.openViaUrlBar('gamma');
    await driver.minimize();
    await driver.gotoBrowserTab();

    const before = server.loadCount('gamma');
    await driver.openViaTile('gamma');
    expect(
      server.loadCount('gamma'),
      'tapping the tile for an already-open dApp should restore it, not re-fetch it'
    ).toBe(before);
    await driver.expectDappPainted('gamma', 'gamma-from-tile');
  });

  await steps.step('navigate_away_keeps_tiles_visible', async () => {
    await driver.minimize();
    // Leaving the browser tab entirely — the tray is portalled above the whole
    // shell, so the parked dApps must still be represented on Home.
    await driver.navigateAwayToHome();

    const cards = await driver.peekCards();
    const urls = cards.map(c => c.url);
    expect(urls, 'alpha should still have a tile after leaving the browser tab').toContain(server.urlFor('alpha'));
    expect(urls, 'beta should still have a tile after leaving the browser tab').toContain(server.urlFor('beta'));
    expect(urls, 'gamma should still have a tile after leaving the browser tab').toContain(server.urlFor('gamma'));

    for (const card of cards) {
      expect(card.rect.width, `tile ${card.url} should still be laid out on Home`).toBeGreaterThanOrEqual(80);
    }
    await driver.expectRegionNotBlank(cards[0]!.rect, 'tiles-on-home');
  });

  await steps.step('restore_from_home_returns_to_browser', async () => {
    // Tapping a tile from another tab has to navigate back to /browser AND
    // bring the webview up — a path with its own history of parking the
    // session again on the first tap.
    await driver.restoreViaPeekCard('beta');
    await driver.expectDappPainted('beta', 'beta-restored-from-home');
    await driver.expectRelayoutMatchesSlot('beta', 'beta-restored-layout');
    await driver.expectFreshFrame('beta', 'beta-restored-from-home');
  });

  await steps.step('close_dapp_removes_its_tile', async () => {
    const before = await driver.state();
    const beforeCount = before.sessions.length;
    await driver.closeForeground();

    const after = await driver.state();
    expect(after.sessions, 'closing should drop exactly one session').toHaveLength(beforeCount - 1);
    expect(
      after.sessions.map(s => s.url),
      'the closed dApp should no longer be tracked'
    ).not.toContain(server.urlFor('beta'));

    const cards = await driver.peekCards();
    expect(
      cards.map(c => c.url),
      'the closed dApp should no longer have a tile'
    ).not.toContain(server.urlFor('beta'));
  });
}
