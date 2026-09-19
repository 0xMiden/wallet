import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { ReactComponent as GroupAboutIcon } from 'app/icons/settings/group-about.svg';
import { ReactComponent as GroupDeveloperIcon } from 'app/icons/settings/group-developer.svg';
import { ReactComponent as GroupPreferencesIcon } from 'app/icons/settings/group-preferences.svg';
import { ReactComponent as GroupSecurityIcon } from 'app/icons/settings/group-security.svg';
import { Icon, IconName } from 'app/icons/v2';
import AddressBook from 'app/templates/AddressBook';
import DAppDrawerSettings from 'app/templates/DAppDrawerSettings';
import DAppSettings from 'app/templates/DAppSettings';
import EditMidenFaucetId from 'app/templates/EditMidenFaucetId';
import GeneralSettings from 'app/templates/GeneralSettings';
import GuardianSettings from 'app/templates/GuardianSettings';
import KeysSettings from 'app/templates/KeysSettings';
import LanguageSettings from 'app/templates/LanguageSettings';
import RevealSecret from 'app/templates/RevealSecret';
import RevealSeedPhraseFlow from 'app/templates/RevealSeedPhrase';
import VerifySeedPhraseFlow from 'app/templates/VerifySeedPhraseFlow';
import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SectionHeader } from 'components/ui/SectionHeader';
// Imported from the module rather than the `components/ui` barrel: the barrel
// pulls in siblings that touch `lib/platform` at module scope, which this
// page's test suite mocks only partially.
import { TabHeader } from 'components/ui/TabHeader';
import { getCurrentLocale } from 'lib/i18n/core';
import { isEndpointOverrideActive } from 'lib/miden-chain/effective-endpoints';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { useHideDappBubblesWhileOpen } from 'lib/mobile/useHideDappBubblesWhileOpen';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { HistoryAction, navigate } from 'lib/woozie';
import { EncryptedFileFlow } from 'screens/encrypted-file-flow/EncryptedFileManager';
import { WalletType } from 'screens/onboarding/types';

import AdvancedSettings from './AdvancedSettings';
import NetworksSettings from './Networks';
import { SettingsSelectors } from './Settings.selectors';
import pkg from '../../../package.json';
import { FEEDBACK_URL, PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from '../constants';

type SettingsProps = {
  tabSlug?: string | null;
  rootScrollTop?: React.MutableRefObject<number>;
};

const RevealPrivateKey: FC = () => {
  const currentAccountType = useWalletStore(s => s.currentAccount?.type);
  const isGuardian = currentAccountType === WalletType.Guardian;
  return <RevealSecret reveal={isGuardian ? 'guardian-keys' : 'private-key'} />;
};

const RemoveSeedPhrase: FC = () => <VerifySeedPhraseFlow remove />;

const RevealHotKey: FC = () => <RevealSecret reveal="hot-key" />;

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  pt: 'Portuguese',
  ru: 'Russian'
};

function getCurrentLanguageLabel(): string {
  const locale = getCurrentLocale();
  const base = locale.split(/[-_]/)[0];
  return LANGUAGE_LABELS[base] || base;
}

type Tab = {
  slug: string;
  titleI18nKey: string;
  pageTitleI18nKey?: string;
  // Sub-pages are routed, so they own their own exit — none of them takes a host
  // close handler any more.
  Component: React.FC;
  testID?: SettingsSelectors;
  hasOwnLayout?: boolean;
  rightText?: string;
  linksOutsideOfWallet?: boolean;
  onClick?: () => void;
  guardianOnly?: boolean;
  requiresSeedPhrase?: boolean;
  /**
   * This tab's panel renders its OWN notice when the seed phrase is not 'stored'
   * (an interrupted removal, or a finished one), so its route must keep resolving
   * after the menu row is hidden - see allTabs. Only set it where the component
   * actually renders something: RevealSecret returns null in that state, so a
   * route to it would resolve to a header with a blank body.
   */
  reportsSeedState?: boolean;
  /**
   * Set when the sub-page focuses a field on mount in a `useLayoutEffect`, which
   * runs BEFORE the host's title focus and would therefore lose the caret to it.
   *
   * Prefer not to need this. A page whose focus call is a passive `useEffect`
   * lands after the title focus and wins on its own, which is strictly better:
   * the title is announced, and the field is only claimed if it actually rendered.
   * Declaring the flag makes the host guess, and a page whose field is
   * conditional will guess wrong — `RevealSecret` renders no password input at
   * all when a hardware protector is present, so the suppression left that route
   * with nothing focused and no announcement, the exact defect
   * `focusTitleOnMount` exists to fix. A predicate rather than a boolean for the
   * same reason: whatever remains here is platform-dependent.
   */
  ownsInitialFocus?: () => boolean;
  // Hide on Guardian accounts whose hot key is not yet activated (post-recovery,
  // pre-banner-click). The corresponding Settings flow needs a `hotPublicKey`
  // set on the WalletAccount or it'll fail immediately on the vault lookup.
  requiresActivatedHotKey?: boolean;
};

type TabGroup = {
  titleI18nKey: string;
  /** The group's coloured 16px glyph, shown in a `SectionHeader`'s 32px circle. */
  Icon: ImportedSVGComponent;
  tabs: Tab[];
};

const TAB_GROUPS: TabGroup[] = [
  {
    titleI18nKey: 'preferences',
    Icon: GroupPreferencesIcon,
    tabs: [
      {
        slug: 'general-settings',
        titleI18nKey: 'generalSettings',
        Component: GeneralSettings,
        testID: SettingsSelectors.GeneralButton
      },
      {
        slug: 'address-book',
        titleI18nKey: 'addressBook',
        Component: AddressBook,
        testID: SettingsSelectors.AddressBookButton
      },
      {
        slug: 'language',
        titleI18nKey: 'language',
        Component: LanguageSettings,
        testID: SettingsSelectors.LanguageButton
      }
    ]
  },
  {
    titleI18nKey: 'security',
    Icon: GroupSecurityIcon,
    tabs: [
      {
        slug: 'reveal-seed-phrase',
        titleI18nKey: 'recoveryPhrase',
        Component: RevealSeedPhraseFlow,
        requiresSeedPhrase: true,
        reportsSeedState: true,
        testID: SettingsSelectors.RevealSeedPhraseButton,
        hasOwnLayout: true
      },
      {
        slug: 'remove-seed-phrase',
        titleI18nKey: 'removeSeedPhrase',
        Component: RemoveSeedPhrase,
        requiresSeedPhrase: true,
        reportsSeedState: true,
        hasOwnLayout: true
      },
      {
        slug: 'keys',
        titleI18nKey: 'keys',
        Component: KeysSettings,
        testID: SettingsSelectors.KeysButton
      },
      {
        slug: 'encrypted-wallet-file',
        titleI18nKey: 'encryptedWalletFile',
        Component: EncryptedFileFlow,
        testID: SettingsSelectors.EncryptedWalletFile,
        hasOwnLayout: true
      },
      {
        slug: 'guardian-settings',
        titleI18nKey: 'guardianSettings',
        // No `pageTitleI18nKey` override: 'rotateGuardian' came over from the old
        // `drawerTitleI18nKey`, where it named a task sheet. A routed page's <h1>
        // is the page's identity, and this one is the Guardian overview —
        // provider, endpoint, region, last sync — with Rotate as its CTA. Since
        // `focusTitleOnMount` is on here, tapping the row labelled "Guardian
        // Settings" announced "Rotate Guardian, heading level 1".
        Component: GuardianSettings,
        // Needed now the row is a routed Link: ListRow forwards its testid to both
        // the anchor and Link's analytics call, and an absent one became an
        // empty data-testid plus a ButtonPress event with an empty name.
        testID: SettingsSelectors.GuardianSettingsButton,
        guardianOnly: true
      }
    ]
  },
  {
    titleI18nKey: 'developer',
    Icon: GroupDeveloperIcon,
    tabs: [
      {
        slug: 'advanced-settings',
        titleI18nKey: 'advancedSettings',
        Component: AdvancedSettings,
        testID: SettingsSelectors.AdvancedSettingsButton
      },
      {
        // Distinct slug: the connected-dApps list page owns '/settings/dapps'
        // (HIDDEN_TABS below); this entry is the toggle screen linking to it.
        slug: 'dapp-settings',
        titleI18nKey: 'authorizedDApps',
        Component: DAppDrawerSettings,
        testID: SettingsSelectors.DAppsButton
      }
    ]
  },
  {
    titleI18nKey: 'about',
    Icon: GroupAboutIcon,
    tabs: [
      {
        slug: PRIVACY_POLICY_URL,
        titleI18nKey: 'privacyPolicy',
        Component: () => null,
        linksOutsideOfWallet: true
      },
      {
        slug: TERMS_OF_USE_URL,
        titleI18nKey: 'termsOfService',
        Component: () => null,
        linksOutsideOfWallet: true
      },
      {
        // Opens the hosted feedback form. Not an external <a> because that would
        // hit the system browser on mobile; the onClick routes through
        // openExternalUrl (native in-app webview on mobile, new tab on desktop).
        slug: 'send-feedback',
        titleI18nKey: 'sendFeedback',
        Component: () => null,
        testID: SettingsSelectors.SendFeedbackButton,
        onClick: () => {
          openExternalUrl({ url: FEEDBACK_URL, title: 'Send feedback' });
        }
      }
    ]
  }
];

// Hidden tabs that are routable but not shown in the menu
const HIDDEN_TABS: Tab[] = [
  {
    slug: 'reveal-private-key',
    titleI18nKey: 'revealPrivateKey',
    Component: RevealPrivateKey,
    requiresSeedPhrase: true,
    testID: SettingsSelectors.RevealPrivateKeyButton
  },
  {
    slug: 'reveal-hot-key',
    titleI18nKey: 'revealPrivateKey',
    Component: RevealHotKey,
    testID: SettingsSelectors.RevealHotKeyButton,
    guardianOnly: true,
    requiresActivatedHotKey: true
  },
  {
    slug: 'verify-seed-phrase',
    titleI18nKey: 'verifySeedPhrase',
    Component: VerifySeedPhraseFlow,
    hasOwnLayout: true
  },
  {
    slug: 'edit-miden-faucet-id',
    // Unconditional: EditMidenFaucetId focuses its field on every platform.
    ownsInitialFocus: () => true,
    titleI18nKey: 'editMidenFaucetId',
    Component: EditMidenFaucetId,
    testID: SettingsSelectors.EditMidenFaucetButton
  },
  {
    slug: 'networks',
    titleI18nKey: 'networks',
    Component: NetworksSettings,
    testID: SettingsSelectors.NetworksButton
  },
  {
    slug: 'dapps',
    titleI18nKey: 'authorizedDApps',
    Component: DAppSettings
  }
];

// Visibility predicate for the read-only "Network endpoints" row: only shown
// while a developer endpoint override is active (see lib/miden-chain/effective-endpoints).
export async function shouldShowDevEndpointsRow(): Promise<boolean> {
  return isEndpointOverrideActive();
}

const Settings: FC<SettingsProps> = ({ tabSlug, rootScrollTop: savedRootScrollTop }) => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const currentAccountType = useWalletStore(s => s.currentAccount?.type);
  const currentAccountHotPublicKey = useWalletStore(s => s.currentAccount?.hotPublicKey);
  const seedPhraseStatus = useWalletStore(s => s.seedPhraseStatus);
  const isGuardianAccount = currentAccountType === WalletType.Guardian;
  const hasActivatedHotKey = Boolean(currentAccountHotPublicKey);

  // Whether the account HAS this page at all. A non-Guardian account has no
  // Guardian page in any sense, so these gates block the route as well as the row.
  const tabIsRoutable = useCallback(
    (tab: Tab) => {
      if (tab.guardianOnly && !isGuardianAccount) return false;
      if (tab.requiresActivatedHotKey && !hasActivatedHotKey) return false;
      return true;
    },
    [isGuardianAccount, hasActivatedHotKey]
  );

  // Whether the MENU offers it. The seed gate is only about the row: see allTabs.
  const tabIsVisible = useCallback(
    (tab: Tab) => {
      if (tab.requiresSeedPhrase && seedPhraseStatus !== 'stored') return false;
      return tabIsRoutable(tab);
    },
    [tabIsRoutable, seedPhraseStatus]
  );

  // Read-only "Network endpoints" row: only shown while a developer endpoint
  // override is active. Resolved async on mount; cancellation-safe so a fast
  // unmount can't set state on a gone component.
  const [showDevEndpoints, setShowDevEndpoints] = useState(false);
  useEffect(() => {
    let cancelled = false;
    shouldShowDevEndpointsRow().then(v => {
      if (!cancelled) setShowDevEndpoints(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Filter tabs that are gated to Guardian accounts. Non-Guardian users don't see
  // the Guardian Settings entry at all (menu row or routable page).
  const tabGroups = useMemo(() => {
    const groups = TAB_GROUPS.map(group => ({
      ...group,
      tabs: group.tabs.filter(tabIsVisible)
    })).filter(group => group.tabs.length > 0);

    if (!showDevEndpoints) return groups;

    const devEndpointsTab: Tab = {
      slug: 'network-endpoints',
      titleI18nKey: 'devEndpointsRow',
      Component: () => null,
      hasOwnLayout: true
    };

    return groups.map(group =>
      group.titleI18nKey === 'developer' ? { ...group, tabs: [...group.tabs, devEndpointsTab] } : group
    );
  }, [tabIsVisible, showDevEndpoints]);

  // Menu visibility and route resolvability are different questions, and this is
  // the list that resolves a sub-page route. A seed-gated tab is hidden from the
  // menu once the phrase is gone, but its panel is the ONLY place that reports an
  // interrupted removal ('removing', which unlock retries) or a completed one, so
  // the route has to keep resolving or that state has no surface at all.
  //
  // Restricted to `reportsSeedState`, NOT every seed-gated tab. Guarding itself
  // and reporting itself are different things: RevealSeedPhrase (:139) and
  // VerifySeedPhraseFlow (:172) render a notice, but RevealSecret returns null
  // (:398, and its own test asserts childElementCount 0), so restoring
  // reveal-private-key's route would resolve to a header over a blank body -
  // worse than invalidTab's bounce, not better.
  const allTabs = useMemo(
    () => [
      ...tabGroups.flatMap(g => g.tabs),
      ...HIDDEN_TABS.filter(tabIsVisible),
      ...[...TAB_GROUPS.flatMap(g => g.tabs), ...HIDDEN_TABS].filter(
        tab => tab.reportsSeedState && !tabIsVisible(tab) && tabIsRoutable(tab)
      )
    ],
    [tabGroups, tabIsVisible, tabIsRoutable]
  );

  const activeTab = useMemo(() => allTabs.find(tab => tab.slug === tabSlug) || null, [allTabs, tabSlug]);
  const handleSubPageBack = useBackWithFallback('/settings');
  const languageLabel = getCurrentLanguageLabel();
  const [showSeedWarning, setShowSeedWarning] = useState(false);
  // PageRouter owns the root offset because changing between TabLayout and
  // FullScreenPage remounts Settings. Standalone instances keep a local fallback.
  const localRootScrollTop = useRef(0);
  const rootScrollTop = savedRootScrollTop ?? localRootScrollTop;
  const invalidTab = Boolean(tabSlug) && !activeTab;

  useEffect(() => {
    // The root menu needs TabLayout's footer. Do not render it inside the
    // full-screen route when a slug is unknown or unavailable to this account.
    if (invalidTab) navigate('/settings', HistoryAction.Replace);
  }, [invalidTab]);

  // On mobile, move parked dApp trays out while the seed-warning overlay or a
  // settings sub-page owns the screen. The sub-pages need it for the same
  // reason the drawers they replaced did: the tray floats above the bottom of
  // the viewport, which is where these screens pin their primary action.
  //
  // Through the shared hook rather than the body attribute directly: the flag is
  // reference-counted, and RevealSecret and every CustomModal are also holders.
  // Setting it here by hand meant a modal closing over a settings sub-page (the
  // confirm in Address Book, say) dropped the count to zero and cleared the flag
  // while this page still wanted it.
  useHideDappBubblesWhileOpen(showSeedWarning || activeTab !== null);

  // Mark Settings as an edge-to-edge page. The list container below
  // adds its own bottom padding so the last item can still scroll above
  // the React BottomNav.
  const showSettingsRoot = !tabSlug;
  useEffect(() => {
    if (!isMobile()) return;
    if (showSettingsRoot) {
      document.body.setAttribute('data-edge-to-edge', '');
    } else {
      document.body.removeAttribute('data-edge-to-edge');
    }
    return () => {
      document.body.removeAttribute('data-edge-to-edge');
    };
  }, [showSettingsRoot]);

  // Neither of these buzzes: both are rendered by `Button`, which fires a
  // hapticLight on every click. Close buzzed twice and View fired a medium AND a
  // light on one tap — the same double-fire as the recovery-phrase row, hidden
  // here because the Button mock in the tests does not haptic.
  const handleSeedWarningClose = useCallback(() => {
    setShowSeedWarning(false);
  }, []);

  const handleSeedWarningView = useCallback(() => {
    setShowSeedWarning(false);
    navigate('/settings/reveal-seed-phrase');
  }, []);

  if (invalidTab) return null;

  return (
    <>
      {/* Headers sit OUTSIDE the scroll container below: a sub-page's header
          carries its only back affordance, and Language or Address Book
          overflow the popup, which would scroll it away. */}
      {activeTab ? (
        !activeTab.hasOwnLayout && (
          <PageHeader
            className="px-4"
            title={t(activeTab.pageTitleI18nKey ?? activeTab.titleI18nKey)}
            onBack={handleSubPageBack}
            // As drawers these screens were dialogs, so they took focus and were
            // announced by name. Routes are not announced and the row that
            // opened them unmounts with the list, dropping focus to <body>.
            // Skipped for the pages that focus a field themselves — see
            // `ownsInitialFocus`.
            focusTitleOnMount={!activeTab.ownsInitialFocus?.()}
            // Prefixed: the scroll container below is a sibling in this same
            // fragment and keys on the slug too, and two siblings sharing a key
            // makes React render both of them.
            key={`header-${activeTab.slug}`}
          />
        )
      ) : (
        // Settings root is a primary tab destination, so it wears the same
        // header as Activity and Explore: a plain title, no back chevron.
        // Sub-pages above keep PageHeader — that back arrow is their only
        // way out.
        <TabHeader title={t('settings')} />
      )}

      {/* Sibling sub-pages share a layout, so key their scrollers to prevent
          one page inheriting another's offset. Restore only the root list. */}
      <div
        key={activeTab?.slug ?? 'root'}
        // A ref avoids re-rendering the page on every scroll event.
        ref={node => {
          if (node && !activeTab) node.scrollTop = rootScrollTop.current;
        }}
        onScroll={
          activeTab
            ? undefined
            : event => {
                rootScrollTop.current = event.currentTarget.scrollTop;
              }
        }
        className="flex-1 min-h-0 overflow-y-auto bg-app-bg flex flex-col"
      >
        {activeTab ? (
          activeTab.hasOwnLayout ? (
            <activeTab.Component />
          ) : (
            // No `onClose`: the sub-pages that still call it do so immediately
            // before navigating on, and popping first would race the push. The
            // one screen whose action means "done here" pops itself.
            //
            // `font-heading` stays. Dropping it to fix a font was the wrong scope:
            // the problem was that Preflight sets `font: inherit` on form controls,
            // so RevealSecret's recovery-phrase and private-key textareas inherited
            // the display face for the app's highest-stakes text — but removing the
            // blanket switched all twelve routed screens to Inter to fix those two
            // fields, and only LanguageSettings kept Nunito, by way of an inline
            // style. The textareas ask for `font-sans` themselves instead.
            <div className="font-heading px-4 flex-1 flex flex-col min-h-0">
              <activeTab.Component />
            </div>
          )
        ) : (
          // pb-22 reserves space at the bottom so the last row can scroll above
          // the React BottomNav.
          <div className="flex w-full flex-col gap-5 px-4 pt-1 pb-22">
            {tabGroups.map(group => (
              <section key={group.titleI18nKey}>
                {/* h2: the only heading above these is the page title the header
                    renders as h1. `lg` + the group's own coloured glyph: these are
                    page-level section titles, not the plain 13px list-group label. */}
                <SectionHeader size="lg" icon={<group.Icon />}>
                  {t(group.titleI18nKey)}
                </SectionHeader>
                <ListGroup>
                  {group.tabs.map(tab => {
                    const isExternal = tab.linksOutsideOfWallet;
                    const isSeedPhrase = tab.slug === 'reveal-seed-phrase';
                    // A tab may carry its own onClick (e.g. Send feedback →
                    // openExternalUrl); such rows never route to a /settings page.
                    const hasCustomClick = isSeedPhrase || !!tab.onClick;
                    // No `hapticLight()` here: ListRow fires one for every branch
                    // it renders, so adding one buzzed twice per tap.
                    const handleClick = isSeedPhrase ? () => setShowSeedWarning(true) : tab.onClick;
                    return (
                      <ListRow
                        key={tab.slug + tab.titleI18nKey}
                        title={t(tab.titleI18nKey)}
                        to={isExternal || hasCustomClick ? undefined : `/settings/${tab.slug}`}
                        href={isExternal ? tab.slug : undefined}
                        onClick={isExternal ? undefined : handleClick}
                        value={tab.slug === 'language' ? languageLabel : undefined}
                        // Every row opens something: a page, a sheet or a site.
                        chevron
                        data-testid={tab.testID}
                      />
                    );
                  })}
                </ListGroup>
              </section>
            ))}

            <p className="px-1 font-sans text-[13px] text-muted">{t('settingsVersion', { version: pkg.version })}</p>
          </div>
        )}
      </div>

      {/* Seed phrase warning overlay */}
      <AnimatePresence>
        {showSeedWarning && (
          <motion.div
            key="seed-warning"
            className="absolute inset-0 z-50 flex flex-col backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
          >
            <motion.div
              className="flex-1 flex flex-col"
              initial={{ y: reduceMotion ? 0 : 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: reduceMotion ? 0 : 40, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <div className="mt-6 px-4">
                <div className="bg-gray-25 rounded-2xl px-6 py-8">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-5 place-items-center">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <div key={i} className="h-1.5 rounded-full bg-gray-50" style={{ width: 144 }} />
                    ))}
                  </div>
                </div>

                <div className="mt-4 bg-white rounded-xl p-4 text-center">
                  <p className="text-sm text-heading-gray">{t('pleaseWriteDownRecoveryPhrase')}</p>
                </div>
              </div>

              <div className="mt-auto pt-6 pb-6 flex flex-col items-center text-center bg-white rounded-t-2xl">
                <div className="flex flex-col px-6 items-center">
                  <div className="w-10 h-10 rounded-sm bg-primary-500 flex items-center justify-center mb-4">
                    <Icon name={IconName.EyeOff} size="md" fill="white" />
                  </div>

                  <h3 className="text-base font-medium text-black mb-1">{t('viewThisInPrivatePlace')}</h3>
                  <p className="text-sm text-black mb-8 font-medium">{t('anyoneWithRecoveryPhrase')}</p>
                </div>
                <div className="flex gap-4 w-full px-4">
                  <Button
                    className="flex-1 justify-center"
                    variant={ButtonVariant.Secondary}
                    title={t('close')}
                    onClick={handleSeedWarningClose}
                  />
                  <Button
                    className="flex-1 justify-center"
                    variant={ButtonVariant.Primary}
                    title={t('view')}
                    onClick={handleSeedWarningView}
                  />
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default Settings;
