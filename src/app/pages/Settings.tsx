import React, { FC, useCallback, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { openInFullPage, useAppEnv } from 'app/env';
import { ReactComponent as ContactBookIcon } from 'app/icons/contact-book.svg';
import { ReactComponent as ExtensionIcon } from 'app/icons/extension.svg';
import { ReactComponent as InfoIcon } from 'app/icons/information.svg';
import { ReactComponent as MaximiseIcon } from 'app/icons/maximise.svg';
import { ReactComponent as ToolIcon } from 'app/icons/settings/advanced-settings.svg';
import { ReactComponent as AppsIcon } from 'app/icons/settings/dapp.svg';
import { ReactComponent as EncryptedWalletIcon } from 'app/icons/settings/encrypted-wallet-file.svg';
import { ReactComponent as SettingsIcon } from 'app/icons/settings/general.svg';
import { ReactComponent as LanguageIcon } from 'app/icons/settings/language.svg';
import { ReactComponent as KeyIcon } from 'app/icons/settings/secret-key.svg';
import About from 'app/templates/About';
import AddressBook from 'app/templates/AddressBook';
import DAppSettings from 'app/templates/DAppSettings';
import EditMidenFaucetId from 'app/templates/EditMidenFaucetId';
import GeneralSettings from 'app/templates/GeneralSettings';
import LanguageSettings from 'app/templates/LanguageSettings';
import MenuItem from 'app/templates/MenuItem';
import RevealSecret from 'app/templates/RevealSecret';
import { NavigationHeader } from 'components/NavigationHeader';
import { useAccount } from 'lib/miden/front';
import { goBack } from 'lib/woozie';
import { EncryptedFileFlow } from 'screens/encrypted-file-flow/EncryptedFileManager';

import AdvancedSettings from './AdvancedSettings';
import NetworksSettings from './Networks';
import { SettingsSelectors } from './Settings.selectors';

type SettingsProps = {
  tabSlug?: string | null;
};

// const RevealViewKey: FC = () => <RevealSecret reveal="view-key" />;
// const RevealPrivateKey: FC = () => <RevealSecret reveal="private-key" />;
const RevealSeedPhrase: FC = () => <RevealSecret reveal="seed-phrase" />;

type Tab = {
  slug: string;
  titleI18nKey: string;
  Icon: React.FC<{ style?: React.CSSProperties }>;
  Component: React.FC;
  descriptionI18nKey: string;
  testID?: SettingsSelectors;
  iconStyle?: React.CSSProperties;
  hasOwnLayout?: boolean;
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
        descriptionI18nKey: 'generalSettingsDescription',
        testID: SettingsSelectors.GeneralButton
      },
      {
        slug: 'address-book',
        titleI18nKey: 'addressBook',
        Icon: SettingsIcon,
        Component: AddressBook,
        descriptionI18nKey: 'addressBookDescription',
        testID: SettingsSelectors.AddressBookButton,
        iconStyle: { stroke: '#000', strokeWidth: '2px' }
      },
      {
        slug: 'language',
        titleI18nKey: 'language',
        Icon: LanguageIcon,
        Component: LanguageSettings,
        descriptionI18nKey: 'languageDescription',
        testID: SettingsSelectors.LanguageButton,
        iconStyle: { stroke: '#000', strokeWidth: '2px' }
      }
    ]
  },
  {
    titleI18nKey: 'security',
    tabs: [
      {
        slug: 'reveal-seed-phrase',
        titleI18nKey: 'revealSeedPhrase',
        Icon: KeyIcon,
        Component: RevealSeedPhrase,
        descriptionI18nKey: 'revealSeedPhraseDescription',
        testID: SettingsSelectors.RevealSeedPhraseButton
      },
      {
        slug: 'encrypted-wallet-file',
        titleI18nKey: 'encryptedWalletFile',
        Icon: EncryptedWalletIcon,
        Component: EncryptedFileFlow,
        descriptionI18nKey: 'encryptedWalletFileDescription',
        testID: SettingsSelectors.EncryptedWalletFile,
        iconStyle: { stroke: '#000', strokeWidth: '2px' },
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
        descriptionI18nKey: 'advancedSettingsDescription',
        testID: SettingsSelectors.AdvancedSettingsButton
      },
      {
        slug: 'dapps',
        titleI18nKey: 'authorizedDApps',
        Icon: AppsIcon,
        Component: DAppSettings,
        descriptionI18nKey: 'dAppsDescription',
        testID: SettingsSelectors.DAppsButton
      }
    ]
  },
  {
    titleI18nKey: 'about',
    tabs: [
      {
        slug: 'about',
        titleI18nKey: 'aboutMidenWallet',
        Icon: SettingsIcon,
        Component: About,
        descriptionI18nKey: 'aboutDescription',
        testID: SettingsSelectors.AboutButton
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
    descriptionI18nKey: 'editMidenFaucetIdDescription',
    testID: SettingsSelectors.EditMidenFaucetButton
  },

  {
    slug: 'networks',
    titleI18nKey: 'networks',
    Icon: ExtensionIcon,
    Component: NetworksSettings,
    descriptionI18nKey: 'networkDescription',
    testID: SettingsSelectors.NetworksButton
  }
];

// Flat list of all tabs for route lookup
const ALL_TABS: Tab[] = [...TAB_GROUPS.flatMap(g => g.tabs), ...HIDDEN_TABS];

// TODO: Consider passing tabs in as a prop
const Settings: FC<SettingsProps> = ({ tabSlug }) => {
  const { t } = useTranslation();
  const activeTab = useMemo(() => ALL_TABS.find(tab => tab.slug === tabSlug) || null, [tabSlug]);

  // Content only - container and footer provided by TabLayout
  return (
    <>
      {/* Header - only shown when no active tab */}
      {!activeTab && <NavigationHeader showBorder title={t('settings')} />}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-app-bg flex flex-col">
        {activeTab ? (
          activeTab.hasOwnLayout ? (
            <activeTab.Component />
          ) : (
            <>
              <NavigationHeader showBorder title={t(activeTab.titleI18nKey)} onBack={goBack} />
              <div className="px-4 flex-1 flex flex-col min-h-0">
                <activeTab.Component />
              </div>
            </>
          )
        ) : (
          <div className="flex flex-col w-full py-4 gap-4 text-heading-gray px-4">
            {TAB_GROUPS.map(group => (
              <div key={group.titleI18nKey}>
                <h3 className="font-semibold pb-4">{t(group.titleI18nKey)}</h3>
                <div className="overflow-hidden rounded-10">
                  {group.tabs.map((tab, idx) => {
                    const linkTo = `/settings/${tab.slug}`;
                    return (
                      <React.Fragment key={tab.slug}>
                        <MenuItem
                          slug={linkTo}
                          titleI18nKey={tab.titleI18nKey}
                          descriptionI18nKey={tab.descriptionI18nKey}
                          Icon={tab.Icon}
                          iconStyle={tab.iconStyle}
                          testID={tab.testID?.toString() || ''}
                          linksOutsideOfWallet={false}
                        />
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
};

export default Settings;
