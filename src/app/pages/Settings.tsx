import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

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
import MenuItem from 'app/templates/MenuItem';
import RevealSecret from 'app/templates/RevealSecret';
import RevealSeedPhraseFlow from 'app/templates/RevealSeedPhrase';
import VerifySeedPhraseFlow from 'app/templates/VerifySeedPhraseFlow';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { getCurrentLocale } from 'lib/i18n/core';
import { isEndpointOverrideActive } from 'lib/miden-chain/effective-endpoints';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { useHideDappBubblesWhileOpen } from 'lib/mobile/useHideDappBubblesWhileOpen';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

import AdvancedSettings from './AdvancedSettings';
import NetworksSettings from './Networks';
import { SettingsSelectors } from './Settings.selectors';
import pkg from '../../../package.json';
import { FEEDBACK_URL, PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from '../constants';

type SettingsProps = {
  tabSlug?: string | null;
};

const RevealPrivateKey: FC = () => {
  const currentAccountType = useWalletStore(s => s.currentAccount?.type);
  const isGuardian = currentAccountType === WalletType.Guardian;
  return <RevealSecret reveal={isGuardian ? 'guardian-keys' : 'private-key'} />;
};

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
  /**
   * Set when the sub-page focuses something itself on mount — a password or
   * faucet-id field, via `useLayoutEffect`. The host's title focus runs in a
   * plain `useEffect`, which fires AFTER layout effects, so it would take focus
   * straight back off the field the page just put the caret in.
   */
  ownsInitialFocus?: boolean;
  // Hide on Guardian accounts whose hot key is not yet activated (post-recovery,
  // pre-banner-click). The corresponding Settings flow needs a `hotPublicKey`
  // set on the WalletAccount or it'll fail immediately on the vault lookup.
  requiresActivatedHotKey?: boolean;
};

type TabGroup = {
  titleI18nKey: string;
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
        testID: SettingsSelectors.RevealSeedPhraseButton,
        hasOwnLayout: true
      },
      {
        slug: 'keys',
        titleI18nKey: 'keys',
        Component: KeysSettings,
        testID: SettingsSelectors.KeysButton
      },
      {
        slug: 'guardian-settings',
        titleI18nKey: 'guardianSettings',
        pageTitleI18nKey: 'rotateGuardian',
        Component: GuardianSettings,
        // Needed now the row is a routed Link: MenuItem forwards testID to both
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
    ownsInitialFocus: true,
    titleI18nKey: 'revealPrivateKey',
    Component: RevealPrivateKey,
    testID: SettingsSelectors.RevealPrivateKeyButton
  },
  {
    slug: 'reveal-hot-key',
    ownsInitialFocus: true,
    titleI18nKey: 'revealHotKey',
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
    ownsInitialFocus: true,
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

const Settings: FC<SettingsProps> = ({ tabSlug }) => {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const currentAccountType = useWalletStore(s => s.currentAccount?.type);
  const currentAccountHotPublicKey = useWalletStore(s => s.currentAccount?.hotPublicKey);
  const isGuardianAccount = currentAccountType === WalletType.Guardian;
  const hasActivatedHotKey = Boolean(currentAccountHotPublicKey);

  const tabIsVisible = useCallback(
    (tab: Tab) => {
      if (tab.guardianOnly && !isGuardianAccount) return false;
      if (tab.requiresActivatedHotKey && !hasActivatedHotKey) return false;
      return true;
    },
    [isGuardianAccount, hasActivatedHotKey]
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

  const allTabs = useMemo(
    () => [...tabGroups.flatMap(g => g.tabs), ...HIDDEN_TABS.filter(tabIsVisible)],
    [tabGroups, tabIsVisible]
  );

  const activeTab = useMemo(() => allTabs.find(tab => tab.slug === tabSlug) || null, [allTabs, tabSlug]);
  const handleSubPageBack = useBackWithFallback('/settings');
  const languageLabel = getCurrentLanguageLabel();
  const [showSeedWarning, setShowSeedWarning] = useState(false);

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
  const showSettingsRoot = !activeTab;
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

  return (
    <>
      {/* Headers sit OUTSIDE the scroll container below: a sub-page's header
          carries its only back affordance, and Language or Address Book
          overflow the popup, which would scroll it away. */}
      {activeTab ? (
        !activeTab.hasOwnLayout && (
          <NavigationHeader
            title={t(activeTab.pageTitleI18nKey ?? activeTab.titleI18nKey)}
            onBack={handleSubPageBack}
            variant="prominent"
            titleAlign="left"
            // As drawers these screens were dialogs, so they took focus and were
            // announced by name. Routes are not announced and the row that
            // opened them unmounts with the list, dropping focus to <body>.
            // Skipped for the pages that focus a field themselves — see
            // `ownsInitialFocus`.
            focusTitleOnMount={!activeTab.ownsInitialFocus}
            // Prefixed: the scroll container below is a sibling in this same
            // fragment and keys on the slug too, and two siblings sharing a key
            // makes React render both of them.
            key={`header-${activeTab.slug}`}
          />
        )
      ) : (
        <NavigationHeader title={t('settings')} onBack={() => navigate('/')} variant="prominent" titleAlign="left" />
      )}

      {/* Keyed so the scroller remounts per page. `/settings` and
          `/settings/<slug>` are one route, so React reconciled this container
          instead of replacing it and the offset carried across: opening Language
          from the bottom of the list landed mid-list, and coming back left
          Settings wherever Language had been scrolled to. The drawers this
          replaced never had the problem — they scrolled in their own portal.
          Keyed on the RESOLVED tab, not the raw slug: an unrecognised slug falls
          through to the root list, and keying on the slug gave that same list a
          different identity per bad URL. */}
      <div key={activeTab?.slug ?? 'root'} className="flex-1 min-h-0 overflow-y-auto bg-app-bg flex flex-col">
        {activeTab ? (
          activeTab.hasOwnLayout ? (
            <activeTab.Component />
          ) : (
            // No `onClose`: the sub-pages that still call it do so immediately
            // before navigating on, and popping first would race the push. The
            // one screen whose action means "done here" pops itself.
            <div className="px-4 flex-1 flex flex-col min-h-0 font-heading">
              <activeTab.Component />
            </div>
          )
        ) : (
          // pb-[88px] reserves space at the bottom so the last menu item
          // can scroll above the React BottomNav.
          <div className="flex flex-col w-full pb-22 text-heading-gray px-4">
            <div className="flex flex-col divide-y divide-border-faint">
              {tabGroups.map(group => (
                <div key={group.titleI18nKey} className="py-3 first:pt-0">
                  <div className="flex items-center gap-1.5 pb-3">
                    {/* Decorative: the heading beside it names the group, so an
                        unlabelled graphic in the tree just adds an anonymous
                        node before every section. */}
                    <div
                      aria-hidden="true"
                      className="w-8 h-8 rounded-full bg-gray-25 flex items-center justify-center shrink-0"
                    >
                      <group.Icon className="w-4 h-4" />
                    </div>
                    {/* h2, not h3: the only heading above these is the page title
                        the header renders as h1, so h3 left a gap in the outline
                        and screen-reader heading navigation reported a missing
                        level. */}
                    <h2 className="font-heading text-lg font-bold text-heading-gray">{t(group.titleI18nKey)}</h2>
                  </div>
                  <div className="overflow-hidden flex flex-col gap-4">
                    {group.tabs.map(tab => {
                      const isExternal = tab.linksOutsideOfWallet;
                      const isSeedPhrase = tab.slug === 'reveal-seed-phrase';
                      // A tab may carry its own onClick (e.g. Send feedback →
                      // openExternalUrl); such rows never route to a /settings page.
                      const hasCustomClick = isSeedPhrase || !!tab.onClick;
                      const linkTo = isExternal ? tab.slug : hasCustomClick ? undefined : `/settings/${tab.slug}`;
                      // No `hapticLight()` here: MenuItem fires one for every
                      // branch it renders, so this row buzzed twice on tap while
                      // every other row buzzed once.
                      const handleClick = isSeedPhrase ? () => setShowSeedWarning(true) : tab.onClick;
                      return (
                        <MenuItem
                          key={tab.slug + tab.titleI18nKey}
                          slug={linkTo}
                          titleI18nKey={tab.titleI18nKey}
                          testID={tab.testID}
                          linksOutsideOfWallet={!!isExternal}
                          rightText={tab.slug === 'language' ? languageLabel : undefined}
                          onClick={handleClick}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* `text-heading-gray`, as with the other muted text this PR touched:
                `text-text-muted` is #ababab, which is 2.30:1 on the page, and 14px
                medium is nowhere near the large-text exemption — the PR shrank
                this from text-base without changing the ink. */}
            <p className="font-heading text-sm font-medium text-heading-gray pt-2">
              {t('settingsVersion', { version: pkg.version })}
            </p>
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
