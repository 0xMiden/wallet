import React, { FC, useCallback, useMemo, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ExtensionIcon } from 'app/icons/extension.svg';
import { ReactComponent as AddressBookIcon } from 'app/icons/settings/address-book.svg';
import { ReactComponent as ToolIcon } from 'app/icons/settings/advanced-settings.svg';
import { ReactComponent as AppsIcon } from 'app/icons/settings/dapp.svg';
import { ReactComponent as EncryptedWalletIcon } from 'app/icons/settings/encrypted-wallet-file.svg';
import { ReactComponent as SettingsIcon } from 'app/icons/settings/general.svg';
import { ReactComponent as LanguageIcon } from 'app/icons/settings/language.svg';
import { ReactComponent as PrivacyPolicyIcon } from 'app/icons/settings/privacy-policy.svg';
import { ReactComponent as SeedPhraseIcon } from 'app/icons/settings/seed-phrase.svg';
import { ReactComponent as TosIcon } from 'app/icons/settings/tos.svg';
import { Icon, IconName } from 'app/icons/v2';
import AddressBook from 'app/templates/AddressBook';
import DAppDrawerSettings from 'app/templates/DAppDrawerSettings';
import DAppSettings from 'app/templates/DAppSettings';
import EditMidenFaucetId from 'app/templates/EditMidenFaucetId';
import GeneralSettings from 'app/templates/GeneralSettings';
import LanguageSettings from 'app/templates/LanguageSettings';
import MenuItem from 'app/templates/MenuItem';
import RevealSeedPhraseFlow from 'app/templates/RevealSeedPhrase';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { getCurrentLocale } from 'lib/i18n/core';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { goBack, navigate } from 'lib/woozie';
import { EncryptedFileFlow } from 'screens/encrypted-file-flow/EncryptedFileManager';

import pkg from '../../../package.json';
import AdvancedSettings from './AdvancedSettings';
import NetworksSettings from './Networks';
import { SettingsSelectors } from './Settings.selectors';

type SettingsProps = {
  tabSlug?: string | null;
};

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
  Icon: React.FC<{ style?: React.CSSProperties }>;
  Component: React.FC<{ onClose?: () => void }>;
  testID?: SettingsSelectors;
  iconStyle?: React.CSSProperties;
  hasOwnLayout?: boolean;
  rightText?: string;
  linksOutsideOfWallet?: boolean;
  isDrawer?: boolean;
  onClick?: () => void;
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
        slug: 'encrypted-wallet-file',
        titleI18nKey: 'encryptedWalletFile',
        Icon: EncryptedWalletIcon,
        Component: EncryptedFileFlow,
        testID: SettingsSelectors.EncryptedWalletFile,
        hasOwnLayout: true
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
        slug: '#',
        titleI18nKey: 'privacyPolicy',
        Icon: PrivacyPolicyIcon,
        Component: () => null,
        linksOutsideOfWallet: true
      },
      {
        slug: '#',
        titleI18nKey: 'termsOfService',
        Icon: TosIcon,
        Component: () => null,
        linksOutsideOfWallet: true
      }
    ]
  }
];

// Hidden tabs that are routable but not shown in the menu
const HIDDEN_TABS: Tab[] = [
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

// Flat list of all tabs for route lookup
const ALL_TABS: Tab[] = [...TAB_GROUPS.flatMap(g => g.tabs), ...HIDDEN_TABS];

// Collect all drawer tabs for rendering
const DRAWER_TABS = TAB_GROUPS.flatMap(g => g.tabs).filter(t => t.isDrawer);

const Settings: FC<SettingsProps> = ({ tabSlug }) => {
  const { t } = useTranslation();
  const activeTab = useMemo(() => ALL_TABS.find(tab => tab.slug === tabSlug && !tab.isDrawer) || null, [tabSlug]);
  const languageLabel = getCurrentLanguageLabel();
  const [openDrawer, setOpenDrawer] = useState<string | null>(null);
  const [showSeedWarning, setShowSeedWarning] = useState(false);

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
          <div className="flex flex-col w-full py-4 gap-8 text-heading-gray px-4">
            {TAB_GROUPS.map(group => (
              <div key={group.titleI18nKey}>
                <h3 className="font-medium pb-4 text-base text-[#868686]">{t(group.titleI18nKey)}</h3>
                <div className="overflow-hidden flex flex-col gap-6">
                  {group.tabs.map(tab => {
                    const isExternal = tab.linksOutsideOfWallet;
                    const isDrawerTab = tab.isDrawer;
                    const isSeedPhrase = tab.slug === 'reveal-seed-phrase';
                    const hasCustomClick = isDrawerTab || isSeedPhrase;
                    const linkTo = isExternal ? tab.slug : hasCustomClick ? undefined : `/settings/${tab.slug}`;
                    const handleClick = isDrawerTab
                      ? () => setOpenDrawer(tab.slug)
                      : isSeedPhrase
                        ? () => {
                            hapticLight();
                            setShowSeedWarning(true);
                          }
                        : undefined;
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

            <p className="text-base font-medium text-grey-300 pt-2">Version {pkg.version}</p>
          </div>
        )}
      </div>

      {DRAWER_TABS.map(tab => (
        <Drawer key={tab.slug} open={openDrawer === tab.slug} onOpenChange={open => !open && setOpenDrawer(null)}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>{t(tab.titleI18nKey)}</DrawerTitle>
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
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <div className="mt-6 px-4">
                <div className="bg-gray-25 rounded-2xl px-6 py-8">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-5 place-items-center">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <div key={i} className="h-1.5 rounded-full bg-[#BABABA]" style={{ width: 144 }} />
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
