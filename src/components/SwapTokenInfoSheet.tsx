import React, { FC, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { AcknowledgeSheet } from 'components/AcknowledgeSheet';
import { swapTokenInfo, type SwapTokenInfo } from 'lib/miden/swap/token-info';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

interface SwapTokenInfoSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  info: SwapTokenInfo;
}

/** What a swap token is and where its swap executes, opened from the "i" on the token (#477). */
export const SwapTokenInfoSheet: FC<SwapTokenInfoSheetProps> = ({ open, onOpenChange, label, info }) => {
  const { t } = useTranslation();
  return (
    <AcknowledgeSheet
      open={open}
      onOpenChange={onOpenChange}
      screenKey="swap-token-info"
      testId="swap-token-info-sheet"
      title={label}
      description={t(info.descriptionKey)}
      descriptionVariant="message"
    >
      {/* The sheet's gutter, and 20px under the description (its own 8px plus 12px): a section apart. */}
      <section className="flex flex-col gap-1 px-4 pt-3">
        <h3 className="text-body-strong text-ink">{t('swapExecutionTitle')}</h3>
        <p className="text-body text-muted">{t(info.executionKey)}</p>
      </section>
    </AcknowledgeSheet>
  );
};

export interface SwapTokenInfoButtonProps {
  faucetId: string | undefined;
  /** The token's display name (`midenTokenLabel`): the sheet's title and the button's label. */
  label: string;
}

/** The "i" on a token that has info; nothing for any other token. */
export const SwapTokenInfoButton: FC<SwapTokenInfoButtonProps> = ({ faucetId, label }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const info = swapTokenInfo(faucetId);
  if (!info) return null;
  return (
    <>
      {/* InfoHint's trigger, so this "i" matches the Rate row's on the same screen: IconButton has no
          24px inline size, and its `circle` would put a 32px disc in the hero line. */}
      <button
        type="button"
        data-testid="swap-token-info-button"
        aria-label={t('tokenInfoLabel', { token: label })}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'relative inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted',
          'before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent-primary'
        )}
        onClick={() => {
          hapticLight();
          setOpen(true);
        }}
      >
        <Icon name={IconName.Information} size="xs" fill="currentColor" aria-hidden="true" />
      </button>
      <SwapTokenInfoSheet open={open} onOpenChange={setOpen} label={label} info={info} />
    </>
  );
};
