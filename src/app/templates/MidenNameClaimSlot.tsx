import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ReactComponent as ChevronRightIcon } from 'app/icons/v2/chevron-right-lucide.svg';
import { IconButton } from 'components/ui/IconButton';
import { useLocalStorage } from 'lib/miden/front/local-storage';
import { isMidenNameSupported } from 'lib/miden/name/config';
import { MIDEN_NAME_SUFFIX } from 'lib/miden/name/encoding';
import { ownedLabelOf, phaseOf, uiStateOf, useMidenNameRegistrations } from 'lib/miden/name/registrations';
import { hapticLight } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

const DISMISSED_KEY = 'miden_name_claim_slot_dismissed';

export interface MidenNameClaimOffer {
  /** The account has no name and no claim in progress, on a network with Miden Name. */
  canClaim: boolean;
  /** The user closed the slot at the top of Settings; the offer lives on in the Miden Name row. */
  dismissed: boolean;
  dismiss: () => void;
}

/** Whether Settings should offer the current account a name, and whether its slot was closed. */
export function useMidenNameClaimOffer(): MidenNameClaimOffer {
  const supported = isMidenNameSupported();
  const publicKey = useWalletStore(s => s.currentAccount?.publicKey);
  const { rows, loaded } = useMidenNameRegistrations(supported ? publicKey : undefined);
  const [dismissed, setDismissed] = useLocalStorage(DISMISSED_KEY, false);

  // Nothing is offered until the registrations have loaded, so an owner never sees the slot flash.
  const canClaim =
    supported &&
    loaded &&
    ownedLabelOf(rows) === undefined &&
    !rows.some(row => uiStateOf(phaseOf(row)) === 'claiming');

  return { canClaim, dismissed, dismiss: () => setDismissed(true) };
}

/**
 * A dashed placeholder where the account's name will go, for an account with no Miden Name. The card
 * opens Claim a name. With `onDismiss` (the top of Settings) an X closes it for good, leaving the
 * Miden Name row's pill; without it (Receive) the whole card is the button, with a chevron.
 */
export const MidenNameClaimSlot: FC<{ onDismiss?: () => void; 'data-testid'?: string }> = ({
  onDismiss,
  'data-testid': testId = 'miden-name-claim-slot'
}) => {
  const { t } = useTranslation();
  const open = () => {
    hapticLight();
    navigate('/miden-name');
  };
  const content = (
    <>
      <span
        aria-hidden="true"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-accent-primary text-accent-primary"
      >
        <Icon name={IconName.Add} size="sm" fill="currentColor" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-heading text-lg font-extrabold text-muted">
          {t('midenNameClaimSlotPlaceholder')}
          <span className="text-accent-primary">{MIDEN_NAME_SUFFIX}</span>
        </span>
        <span className="font-heading text-sm font-semibold text-muted">{t('midenNameClaimSlotSubtitle')}</span>
      </span>
    </>
  );
  const frame = 'flex items-center gap-3 rounded-2xl border border-dashed border-hairline py-3.5 pr-3 pl-3.5';

  if (!onDismiss) {
    return (
      <button
        type="button"
        onClick={open}
        className={`${frame} w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-primary`}
        data-testid={testId}
      >
        {content}
        <ChevronRightIcon aria-hidden="true" className="h-5 w-5 shrink-0 stroke-muted" />
      </button>
    );
  }

  return (
    <div data-testid={testId} className={frame}>
      <button
        type="button"
        onClick={open}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        data-testid={`${testId}-open`}
      >
        {content}
      </button>
      <IconButton
        icon={IconName.Close}
        appearance="circle"
        label={t('midenNameClaimSlotDismiss')}
        onClick={onDismiss}
        data-testid={`${testId}-dismiss`}
      />
    </div>
  );
};
