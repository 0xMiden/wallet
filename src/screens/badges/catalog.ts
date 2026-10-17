import { IconName } from 'app/icons/v2';
import type { BadgeId } from 'lib/badges/types';

export interface BadgeDefinition {
  id: BadgeId;
  titleI18nKey: string;
  descriptionI18nKey: string;
  icon: IconName;
  /** Fail closed until the underlying completion signal is supported. */
  available: boolean;
}

/**
 * The Stage 1 candidate catalog. Unlock state intentionally does not live here: each badge must
 * be awarded from verified Mainnet evidence, never inferred from opening this screen.
 */
export const BADGE_CATALOG: readonly BadgeDefinition[] = [
  {
    id: 'first-deposit',
    available: true,
    titleI18nKey: 'badgeFirstDeposit',
    descriptionI18nKey: 'badgeFirstDepositDescription',
    icon: IconName.BadgeDeposit
  },
  {
    id: 'first-receive',
    available: false,
    titleI18nKey: 'badgeFirstReceive',
    descriptionI18nKey: 'badgeFirstReceiveDescription',
    icon: IconName.BadgeReceive
  },
  {
    id: 'first-send',
    available: true,
    titleI18nKey: 'badgeFirstSend',
    descriptionI18nKey: 'badgeFirstSendDescription',
    icon: IconName.BadgeSend
  },
  {
    id: 'first-swap',
    available: true,
    titleI18nKey: 'badgeFirstSwap',
    descriptionI18nKey: 'badgeFirstSwapDescription',
    icon: IconName.BadgeSwap
  },
  {
    id: 'recovery-checked',
    available: false,
    titleI18nKey: 'badgeRecoveryChecked',
    descriptionI18nKey: 'badgeRecoveryCheckedDescription',
    icon: IconName.BadgeRecovery
  },
  {
    id: 'miniapp-explorer',
    available: false,
    titleI18nKey: 'badgeMiniappExplorer',
    descriptionI18nKey: 'badgeMiniappExplorerDescription',
    icon: IconName.ProfileApps
  }
] as const;
