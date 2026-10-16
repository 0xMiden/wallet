import { IconName } from 'app/icons/v2';

export interface ProfileCategory {
  slug: string;
  titleI18nKey: string;
  icon: IconName;
  entryTitles: readonly string[];
}

export const PROFILE_CATEGORIES: readonly ProfileCategory[] = [
  {
    slug: 'profile-wallet',
    titleI18nKey: 'profileWallet',
    icon: IconName.ProfileWallet,
    entryTitles: ['addressBook', 'spendingLimits', 'networks', 'advancedSettings', 'devEndpointsRow']
  },
  {
    slug: 'profile-preferences',
    titleI18nKey: 'preferences',
    icon: IconName.ProfilePreferences,
    entryTitles: ['generalSettings', 'language']
  },
  {
    slug: 'profile-security',
    titleI18nKey: 'profilePrivacySecurity',
    icon: IconName.ProfileSecurity,
    entryTitles: ['recoveryPhrase', 'keys', 'guardianSettings', 'encryptedWalletFile']
  },
  {
    slug: 'profile-help',
    titleI18nKey: 'profileHelpSupport',
    icon: IconName.ProfileHelp,
    entryTitles: ['support', 'sendFeedback']
  },
  {
    slug: 'profile-legal',
    titleI18nKey: 'profileLegal',
    icon: IconName.ProfileLegal,
    entryTitles: ['privacyPolicy', 'termsOfService']
  }
];
