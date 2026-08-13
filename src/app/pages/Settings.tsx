import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ExtensionIcon } from 'app/icons/extension.svg';
import { ReactComponent as AddressBookIconDevnet } from 'app/icons/settings/address-book-devnet.svg';
import { ReactComponent as AddressBookIconOrange } from 'app/icons/settings/address-book.svg';
import { ReactComponent as ToolIconDevnet } from 'app/icons/settings/advanced-settings-devnet.svg';
import { ReactComponent as ToolIconOrange } from 'app/icons/settings/advanced-settings.svg';
import { ReactComponent as AppsIconDevnet } from 'app/icons/settings/dapp-devnet.svg';
import { ReactComponent as AppsIconOrange } from 'app/icons/settings/dapp.svg';
import { ReactComponent as SettingsIconDevnet } from 'app/icons/settings/general-devnet.svg';
import { ReactComponent as SettingsIconOrange } from 'app/icons/settings/general.svg';
import { ReactComponent as LanguageIconDevnet } from 'app/icons/settings/language-devnet.svg';
import { ReactComponent as LanguageIconOrange } from 'app/icons/settings/language.svg';
import { ReactComponent as PrivacyPolicyIconDevnet } from 'app/icons/settings/privacy-policy-devnet.svg';
import { ReactComponent as PrivacyPolicyIconOrange } from 'app/icons/settings/privacy-policy.svg';
import { ReactComponent as SecretKeyIconDevnet } from 'app/icons/settings/secret-key-devnet.svg';
import { ReactComponent as SecretKeyIconOrange } from 'app/icons/settings/secret-key.svg';
import { ReactComponent as SeedPhraseIconDevnet } from 'app/icons/settings/seed-phrase-devnet.svg';
import { ReactComponent as SeedPhraseIconOrange } from 'app/icons/settings/seed-phrase.svg';
import { ReactComponent as TosIconDevnet } from 'app/icons/settings/tos-devnet.svg';
import { ReactComponent as TosIconOrange } from 'app/icons/settings/tos.svg';
import { Icon, IconName } from 'app/icons/v2';
import { ReactComponent as FeedbackIcon } from 'app/icons/v2/send.svg';
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
import { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { isEndpointOverrideActive } from 'lib/miden-chain/effective-endpoints';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { goBack, navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

import AdvancedSettings from './AdvancedSettings';
import NetworksSettings from './Networks';
import { SettingsSelectors } from './Settings.selectors';
import pkg from '../../../package.json';
import { FEEDBACK_URL, PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from '../constants';

const isDevnet = DEFAULT_NETWORK === MIDEN_NETWORK_NAME.DEVNET;
const AddressBookIcon = isDevnet ? AddressBookIconDevnet : AddressBookIconOrange;
const ToolIcon = isDevnet ? ToolIconDevnet : ToolIconOrange;
const AppsIcon = isDevnet ? AppsIconDevnet : AppsIconOrange;
const SettingsIcon = isDevnet ? SettingsIconDevnet : SettingsIconOrange;
const LanguageIcon = isDevnet ? LanguageIconDevnet : LanguageIconOrange;
const PrivacyPolicyIcon = isDevnet ? PrivacyPolicyIconDevnet : PrivacyPolicyIconOrange;
const SecretKeyIcon = isDevnet ? SecretKeyIconDevnet : SecretKeyIconOrange;
const SeedPhraseIcon = isDevnet ? SeedPhraseIconDevnet : SeedPhraseIconOrange;
const TosIcon = isDevnet ? TosIconDevnet : TosIconOrange;

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
  drawerTitleI18nKey?: string;
  Icon: React.FC<{ style?: React.CSSProperties }>;
  Component: React.FC<{ onClose?: () => void }>;
  testID?: SettingsSelectors;
  iconStyle?: React.CSSProperties;
  hasOwnLayout?: boolean;
  rightText?: string;
  linksOutsideOfWallet?: boolean;
  isDrawer?: boolean;
  onClick?: () => void;
  guardianOnly?: boolean;
  // Hide on Guardian accounts whose hot key is not yet activated (post-recovery,
  // pre-banner-click). The corresponding Settings flow needs a `hotPublicKey`
  // set on the WalletAccount or it'll fail immediately on the vault lookup.
  requiresActivatedHotKey?: boolean;
};

type TabGroup = {
  titleI18nKey: string;
  tabs: Tab[];
};

const TAB_GROUPS: TabGroup[] = [
  {
    titleI18nKey: 'preferences',
    tabs: [
      {
        slug: 'general-settings',
        titleI18nKey: 'generalSettings',
        Icon: SettingsIcon,
        Component: GeneralSettings,
        testID: SettingsSelectors.GeneralButton,
        isDrawer: true
      },
      {
        slug: 'address-book',
        titleI18nKey: 'addressBook',
        Icon: AddressBookIcon,
        Component: AddressBook,
        isDrawer: true,
        testID: SettingsSelectors.AddressBookButton
      },
      {
        slug: 'language',
        titleI18nKey: 'language',
        Icon: LanguageIcon,
        Component: LanguageSettings,
        testID: SettingsSelectors.LanguageButton,
        isDrawer: true
      }
    ]
  },
  {
    titleI18nKey: 'security',
    tabs: [
      {
        slug: 'reveal-seed-phrase',
        titleI18nKey: 'recoveryPhrase',
        Icon: SeedPhraseIcon,
        Component: RevealSeedPhraseFlow,
        testID: SettingsSelectors.RevealSeedPhraseButton,
        hasOwnLayout: true
      },
      {
        slug: 'keys',
        titleI18nKey: 'keys',
        Icon: SecretKeyIcon,
        Component: KeysSettings,
        testID: SettingsSelectors.KeysButton,
        isDrawer: true
      },
      {
        slug: 'guardian-settings',
        titleI18nKey: 'guardianSettings',
        drawerTitleI18nKey: 'rotateGuardian',
        Icon: SettingsIcon,
        Component: GuardianSettings,
        isDrawer: true,
        guardianOnly: true
      }
    ]
  },
  {
    titleI18nKey: 'developer',
    tabs: [
      {
        slug: 'advanced-settings',
        titleI18nKey: 'advancedSettings',
        Icon: ToolIcon,
        Component: AdvancedSettings,
        testID: SettingsSelectors.AdvancedSettingsButton,
        isDrawer: true
      },
      {
        slug: 'dapps',
        titleI18nKey: 'authorizedDApps',
        Icon: AppsIcon,
        Component: DAppDrawerSettings,
        testID: SettingsSelectors.DAppsButton,
        isDrawer: true
      }
    ]
  },
  {
    titleI18nKey: 'about',
    tabs: [
      {
        slug: PRIVACY_POLICY_URL,
        titleI18nKey: 'privacyPolicy',
        Icon: PrivacyPolicyIcon,
        Component: () => null,
        linksOutsideOfWallet: true
      },
      {
        slug: TERMS_OF_USE_URL,
        titleI18nKey: 'termsOfService',
        Icon: TosIcon,
        Component: () => null,
        linksOutsideOfWallet: true
      },
      {
        // Opens the hosted feedback form. Not an external <a> because that would
        // hit the system browser on mobile; the onClick routes through
        // openExternalUrl (native in-app webview on mobile, new tab on desktop).
        slug: 'send-feedback',
        titleI18nKey: 'sendFeedback',
        Icon: FeedbackIcon,
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
    Icon: SecretKeyIcon,
    Component: RevealPrivateKey,
    testID: SettingsSelectors.RevealPrivateKeyButton
  },
  {
    slug: 'reveal-hot-key',
    titleI18nKey: 'revealHotKey',
    Icon: SecretKeyIcon,
    Component: RevealHotKey,
    testID: SettingsSelectors.RevealHotKeyButton,
    guardianOnly: true,
    requiresActivatedHotKey: true
  },
  {
    slug: 'verify-seed-phrase',
    titleI18nKey: 'verifySeedPhrase',
    Icon: SeedPhraseIcon,
    Component: VerifySeedPhraseFlow,
    hasOwnLayout: true
  },
  {
    slug: 'edit-miden-faucet-id',
    titleI18nKey: 'editMidenFaucetId',
    Icon: SettingsIcon,
    Component: EditMidenFaucetId,
    testID: SettingsSelectors.EditMidenFaucetButton
  },
  {
    slug: 'networks',
    titleI18nKey: 'networks',
    Icon: ExtensionIcon,
    Component: NetworksSettings,
    testID: SettingsSelectors.NetworksButton
  },
  {
    slug: 'dapps',
    titleI18nKey: 'authorizedDApps',
    Icon: AppsIcon,
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
  // the Guardian Settings entry at all (menu, drawer, or routable page).
  const tabGroups = useMemo(() => {
    const groups = TAB_GROUPS.map(group => ({
      ...group,
      tabs: group.tabs.filter(tabIsVisible)
    })).filter(group => group.tabs.length > 0);

    if (!showDevEndpoints) return groups;

    const devEndpointsTab: Tab = {
      slug: 'network-endpoints',
      titleI18nKey: 'devEndpointsRow',
      Icon: ToolIcon,
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

  const drawerTabs = useMemo(() => tabGroups.flatMap(g => g.tabs).filter(t => t.isDrawer), [tabGroups]);

  const activeTab = useMemo(
    () => allTabs.find(tab => tab.slug === tabSlug && !tab.isDrawer) || null,
    [allTabs, tabSlug]
  );
  const languageLabel = getCurrentLanguageLabel();
  const [openDrawer, setOpenDrawer] = useState<string | null>(null);
  const [showSeedWarning, setShowSeedWarning] = useState(false);

  // On mobile, move parked dApp trays out when a settings drawer /
  // seed-warning overlay takes over the bottom of the screen.
  const drawerOrSheetOpen = openDrawer !== null || showSeedWarning;
  useEffect(() => {
    if (!isMobile()) return;
    if (drawerOrSheetOpen) {
      document.body.setAttribute('data-drawer-open', '');
    } else {
      document.body.removeAttribute('data-drawer-open');
    }
    // Unmount cleanup: if the Settings page unmounts while a drawer
    // is still open, force parked dApp trays back in.
    return () => {
      if (!isMobile()) return;
      if (drawerOrSheetOpen) {
        document.body.removeAttribute('data-drawer-open');
      }
    };
  }, [drawerOrSheetOpen]);

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

  const handleSeedWarningClose = useCallback(() => {
    hapticLight();
    setShowSeedWarning(false);
  }, []);

  const handleSeedWarningView = useCallback(() => {
    hapticMedium();
    setShowSeedWarning(false);
    navigate('/settings/reveal-seed-phrase');
  }, []);

  return (
    <>
      {!activeTab && <NavigationHeader title={t('settings')} onBack={() => navigate('/')} />}

      <div className="flex-1 min-h-0 overflow-y-auto bg-app-bg flex flex-col">
        {activeTab ? (
          activeTab.hasOwnLayout ? (
            <activeTab.Component />
          ) : (
            <>
              <NavigationHeader title={t(activeTab.titleI18nKey)} onBack={goBack} />
              <div className="px-4 flex-1 flex flex-col min-h-0">
                <activeTab.Component />
              </div>
            </>
          )
        ) : (
          // pb-[88px] reserves space at the bottom so the last menu item
          // can scroll above the React BottomNav.
          <div className="flex flex-col w-full pt-4 pb-22 gap-8 text-heading-gray px-4">
            {tabGroups.map(group => (
              <div key={group.titleI18nKey}>
                <h3 className="font-medium pb-4 text-base text-text-muted">{t(group.titleI18nKey)}</h3>
                <div className="overflow-hidden flex flex-col gap-6">
                  {group.tabs.map(tab => {
                    const isExternal = tab.linksOutsideOfWallet;
                    const isDrawerTab = tab.isDrawer;
                    const isSeedPhrase = tab.slug === 'reveal-seed-phrase';
                    // A tab may carry its own onClick (e.g. Send feedback →
                    // openExternalUrl); such rows never route to a /settings page.
                    const hasCustomClick = isDrawerTab || isSeedPhrase || !!tab.onClick;
                    const linkTo = isExternal ? tab.slug : hasCustomClick ? undefined : `/settings/${tab.slug}`;
                    const handleClick = isDrawerTab
                      ? () => setOpenDrawer(tab.slug)
                      : isSeedPhrase
                        ? () => {
                            hapticLight();
                            setShowSeedWarning(true);
                          }
                        : tab.onClick;
                    return (
                      <div key={tab.slug + tab.titleI18nKey} className="px-2">
                        <MenuItem
                          slug={linkTo}
                          titleI18nKey={tab.titleI18nKey}
                          Icon={tab.Icon}
                          iconStyle={tab.iconStyle}
                          testID={tab.testID?.toString() || ''}
                          linksOutsideOfWallet={!!isExternal}
                          rightText={tab.slug === 'language' ? languageLabel : undefined}
                          onClick={handleClick}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <p className="text-base font-medium text-text-muted pt-2">
              {t('settingsVersion', { version: pkg.version })}
            </p>
          </div>
        )}
      </div>

      {drawerTabs.map(tab => (
        <Drawer key={tab.slug} open={openDrawer === tab.slug} onOpenChange={open => !open && setOpenDrawer(null)}>
          <DrawerContent>
            <DrawerHeader className={tab.slug === 'guardian-settings' ? 'mb-0' : undefined}>
              <DrawerTitle>{t(tab.drawerTitleI18nKey ?? tab.titleI18nKey)}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4 pb-6 overflow-y-auto min-h-0">
              <tab.Component onClose={() => setOpenDrawer(null)} />
            </div>
          </DrawerContent>
        </Drawer>
      ))}

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
