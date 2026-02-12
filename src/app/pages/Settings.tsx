import React, { FC, useCallback, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button } from 'app/atoms/Button';
import { openInFullPage, useAppEnv } from 'app/env';
import { ReactComponent as AppsIcon } from 'app/icons/apps.svg';
import { ReactComponent as ContactBookIcon } from 'app/icons/contact-book.svg';
import { ReactComponent as ExtensionIcon } from 'app/icons/extension.svg';
import { ReactComponent as InfoIcon } from 'app/icons/information.svg';
import { ReactComponent as KeyIcon } from 'app/icons/key.svg';
import { ReactComponent as LanguageIcon } from 'app/icons/language.svg';
import { ReactComponent as MaximiseIcon } from 'app/icons/maximise.svg';
import { ReactComponent as SettingsIcon } from 'app/icons/settings.svg';
import { ReactComponent as StickerIcon } from 'app/icons/sticker.svg';
import { ReactComponent as ToolIcon } from 'app/icons/tool.svg';
import { Icon, IconName } from 'app/icons/v2';
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
import { isMobile } from 'lib/platform';
import { goBack, navigate } from 'lib/woozie';
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
  insertHR: boolean;
  iconStyle?: React.CSSProperties;
  fullDialog?: boolean;
};

const TABS: Tab[] = [
  {
    slug: 'general-settings',
    titleI18nKey: 'generalSettings',
    Icon: SettingsIcon,
    Component: GeneralSettings,
    descriptionI18nKey: 'generalSettingsDescription',
    testID: SettingsSelectors.GeneralButton,
    insertHR: false
  },
  {
    slug: 'language',
    titleI18nKey: 'language',
    Icon: LanguageIcon,
    Component: LanguageSettings,
    descriptionI18nKey: 'languageDescription',
    testID: SettingsSelectors.LanguageButton,
    insertHR: false,
    iconStyle: { stroke: '#000', strokeWidth: '2px' }
  },
  {
    slug: 'address-book',
    titleI18nKey: 'addressBook',
    Icon: ContactBookIcon,
    Component: AddressBook,
    descriptionI18nKey: 'addressBookDescription',
    testID: SettingsSelectors.AddressBookButton,
    insertHR: false,
    iconStyle: { stroke: '#000', strokeWidth: '2px' }
  },
  // {
  //   slug: 'reveal-view-key',
  //   titleI18nKey: 'revealViewKey',
  //   Icon: KeyIcon,
  //   Component: RevealViewKey,
  //   descriptionI18nKey: 'revealViewKeyDescription',
  //   testID: SettingsSelectors.RevealViewKeyButton,
  //   insertHR: true,
  //   iconStyle: { stroke: '#000', strokeWidth: '1px' }
  // },
  // {
  //   slug: 'reveal-private-key',
  //   titleI18nKey: 'revealPrivateKey',
  //   Icon: KeyIcon,
  //   Component: RevealPrivateKey,
  //   descriptionI18nKey: 'revealPrivateKeyDescription',
  //   testID: SettingsSelectors.RevealPrivateKeyButton,
  //   insertHR: false,
  //   iconStyle: { stroke: '#000', strokeWidth: '1px' }
  // },
  {
    slug: 'reveal-seed-phrase',
    titleI18nKey: 'revealSeedPhrase',
    Icon: KeyIcon,
    Component: RevealSeedPhrase,
    descriptionI18nKey: 'revealSeedPhraseDescription',
    testID: SettingsSelectors.RevealSeedPhraseButton,
    insertHR: false,
    iconStyle: { fill: '#000', strokeWidth: '2px' }
  },
  {
    slug: 'edit-miden-faucet-id',
    titleI18nKey: 'editMidenFaucetId',
    Icon: SettingsIcon,
    Component: EditMidenFaucetId,
    descriptionI18nKey: 'editMidenFaucetIdDescription',
    testID: SettingsSelectors.EditMidenFaucetButton,
    insertHR: false
  },
  {
    slug: 'encrypted-wallet-file',
    titleI18nKey: 'encryptedWalletFile',
    Icon: StickerIcon,
    Component: EncryptedFileFlow,
    descriptionI18nKey: 'encryptedWalletFileDescription',
    testID: SettingsSelectors.EncryptedWalletFile,
    insertHR: false,
    iconStyle: { stroke: '#000', strokeWidth: '2px' },
    fullDialog: true
  },
  {
    slug: 'advanced-settings',
    titleI18nKey: 'advancedSettings',
    Icon: ToolIcon,
    Component: AdvancedSettings,
    descriptionI18nKey: 'advancedSettingsDescription',
    testID: SettingsSelectors.AdvancedSettingsButton,
    insertHR: false,
    iconStyle: { stroke: '#000', strokeWidth: '2px' }
  },
  // {
  //   slug: 'remove-account',
  //   titleI18nKey: 'removeAccount',
  //   Icon: MinusIcon,
  //   Component: RemoveAccount,
  //   descriptionI18nKey: 'removeAccountDescription',
  //   testID: SettingsSelectors.RemoveAccountButton,
  //   insertHR: true
  // },
  // {
  //   slug: 'reveal-seed-phrase',
  //   titleI18nKey: 'exportWalletFile',
  //   Icon: FileIcon,
  //   Component: RevealSeedPhrase,
  //   descriptionI18nKey: 'revealSeedPhraseDescription',
  //   testID: SettingsSelectors.RevealSeedPhraseButton,
  //   insertHR: false,
  //   iconStyle: { stroke: '#000', strokeWidth: '0px' }
  // },
  {
    slug: 'dapps',
    titleI18nKey: 'authorizedDApps',
    Icon: AppsIcon,
    Component: DAppSettings,
    descriptionI18nKey: 'dAppsDescription',
    testID: SettingsSelectors.DAppsButton,
    insertHR: true,
    iconStyle: { stroke: '#000', strokeWidth: '1px' }
  },
  {
    slug: 'about',
    titleI18nKey: 'about',
    Icon: InfoIcon,
    Component: About,
    descriptionI18nKey: 'aboutDescription',
    testID: SettingsSelectors.AboutButton,
    insertHR: false,
    iconStyle: { fill: '#000' }
  },
  {
    slug: 'networks',
    titleI18nKey: 'networks',
    Icon: ExtensionIcon,
    Component: NetworksSettings,
    descriptionI18nKey: 'networkDescription',
    testID: SettingsSelectors.NetworksButton,
    insertHR: false
  }
];

// TODO: Consider passing tabs in as a prop
const Settings: FC<SettingsProps> = ({ tabSlug }) => {
  const { t } = useTranslation();
  const activeTab = useMemo(() => TABS.find(tab => tab.slug === tabSlug) || null, [tabSlug]);
  let listMenuItems = TABS.filter(tab => tab.slug !== 'networks' && tab.slug !== 'edit-miden-faucet-id');
  const { fullPage, popup } = useAppEnv();
  const account = useAccount();
  if (!account.isPublic) {
    listMenuItems = listMenuItems.filter(tab => tab.slug !== 'reveal-seed-phrase');
  }

  const handleMaximiseViewClick = useCallback(() => {
    openInFullPage();
    if (popup) {
      window.close();
    }
  }, [popup]);

  const handleBack = useCallback(() => {
    if (activeTab) {
      navigate('/settings');
    } else {
      goBack();
    }
  }, [activeTab]);

  // Content only - container and footer provided by TabLayout
  return (
    <>
      {/* Header */}
      <NavigationHeader showBorder title={t('settings')} />

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-white px-4">
        {activeTab ? (
          <activeTab.Component />
        ) : (
          <div className="flex flex-col w-full py-4">
            {listMenuItems.map(({ slug, titleI18nKey, Icon: MenuIcon, testID, insertHR, iconStyle, fullDialog }) => {
              const linkTo = fullDialog ? slug : `/settings/${slug}`;
              return (
                <MenuItem
                  key={titleI18nKey}
                  slug={linkTo}
                  titleI18nKey={titleI18nKey}
                  Icon={MenuIcon}
                  iconStyle={iconStyle}
                  testID={testID?.toString() || ''}
                  insertHR={insertHR}
                  linksOutsideOfWallet={false}
                />
              );
            })}
            {popup && (
              <MenuItem
                key={'maximise'}
                Icon={MaximiseIcon}
                titleI18nKey={fullPage ? 'openNewTab' : 'maximiseView'}
                slug={'/fullpage.html'}
                onClick={handleMaximiseViewClick}
                insertHR={false}
                iconStyle={{ stroke: '#000', strokeWidth: '2px' }}
                linksOutsideOfWallet={true}
                testID={''}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default Settings;
