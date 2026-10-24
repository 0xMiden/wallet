import { IconName } from 'app/icons/v2';
import firstDepositArt from 'app/misc/badges/first-deposit.png';
import firstReceiveArt from 'app/misc/badges/first-receive.png';
import firstSendArt from 'app/misc/badges/first-send.png';
import firstSwapArt from 'app/misc/badges/first-swap.png';
import miniappExplorerArt from 'app/misc/badges/miniapp-explorer.png';
import recoveryCheckedArt from 'app/misc/badges/recovery-checked.png';
import type { BadgeId } from 'lib/badges/types';

export interface BadgeDefinition {
  id: BadgeId;
  titleI18nKey: string;
  descriptionI18nKey: string;
  icon: IconName;
  /** Illustrated badge art, cropped to its circle (a square image the circle fills). Drawn instead of `icon` when set. */
  art?: string;
  /** Fail closed until the underlying completion signal is supported. */
  available: boolean;
}

/**
 * The Stage 1 candidate catalog. Unlock state intentionally does not live here: each badge must
 * be awarded from verified Mainnet evidence, never inferred from opening this screen.
 */
export const BADGE_CATALOG: readonly BadgeDefinition[] = [
  {
    id: 'first-send',
    available: true,
    titleI18nKey: 'badgeFirstSend',
    descriptionI18nKey: 'badgeFirstSendDescription',
    icon: IconName.BadgeSend,
    art: firstSendArt
  },
  {
    id: 'first-deposit',
    available: true,
    titleI18nKey: 'badgeFirstDeposit',
    descriptionI18nKey: 'badgeFirstDepositDescription',
    icon: IconName.BadgeDeposit,
    art: firstDepositArt
  },
  {
    id: 'first-swap',
    available: true,
    titleI18nKey: 'badgeFirstSwap',
    descriptionI18nKey: 'badgeFirstSwapDescription',
    icon: IconName.BadgeSwap,
    art: firstSwapArt
  },
  {
    id: 'first-receive',
    available: false,
    titleI18nKey: 'badgeFirstReceive',
    descriptionI18nKey: 'badgeFirstReceiveDescription',
    icon: IconName.BadgeReceive,
    art: firstReceiveArt
  },
  {
    id: 'recovery-checked',
    available: false,
    titleI18nKey: 'badgeRecoveryChecked',
    descriptionI18nKey: 'badgeRecoveryCheckedDescription',
    icon: IconName.BadgeRecovery,
    art: recoveryCheckedArt
  },
  {
    id: 'miniapp-explorer',
    available: false,
    titleI18nKey: 'badgeMiniappExplorer',
    descriptionI18nKey: 'badgeMiniappExplorerDescription',
    icon: IconName.ProfileApps,
    art: miniappExplorerArt
  }
] as const;
