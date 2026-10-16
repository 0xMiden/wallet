import { IconName } from 'app/icons/v2';

export interface BadgeDefinition {
  id: 'first-deposit' | 'first-receive' | 'first-send' | 'first-swap' | 'recovery-checked' | 'miniapp-explorer';
  titleI18nKey: string;
  descriptionI18nKey: string;
  icon: IconName;
}

/**
 * The Stage 1 candidate catalog. Unlock state intentionally does not live here: each badge must
 * eventually be awarded from verified Mainnet evidence, never inferred from opening this screen.
 */
export const BADGE_CATALOG: readonly BadgeDefinition[] = [
  {
    id: 'first-deposit',
    titleI18nKey: 'badgeFirstDeposit',
    descriptionI18nKey: 'badgeFirstDepositDescription',
    icon: IconName.BadgeDeposit
  },
  {
    id: 'first-receive',
    titleI18nKey: 'badgeFirstReceive',
    descriptionI18nKey: 'badgeFirstReceiveDescription',
    icon: IconName.BadgeReceive
  },
  {
    id: 'first-send',
    titleI18nKey: 'badgeFirstSend',
    descriptionI18nKey: 'badgeFirstSendDescription',
    icon: IconName.BadgeSend
  },
  {
    id: 'first-swap',
    titleI18nKey: 'badgeFirstSwap',
    descriptionI18nKey: 'badgeFirstSwapDescription',
    icon: IconName.BadgeSwap
  },
  {
    id: 'recovery-checked',
    titleI18nKey: 'badgeRecoveryChecked',
    descriptionI18nKey: 'badgeRecoveryCheckedDescription',
    icon: IconName.BadgeRecovery
  },
  {
    id: 'miniapp-explorer',
    titleI18nKey: 'badgeMiniappExplorer',
    descriptionI18nKey: 'badgeMiniappExplorerDescription',
    icon: IconName.ProfileApps
  }
] as const;
