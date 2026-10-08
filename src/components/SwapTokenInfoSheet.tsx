import React, { FC, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { AcknowledgeSheet } from 'components/AcknowledgeSheet';
import { FactRow, IconCircle } from 'components/ui/FactRow';
import { InfoHintTrigger } from 'components/ui/InfoHint';
import { ListGroup } from 'components/ui/ListGroup';
import { swapTokenInfo, type SwapTokenInfo } from 'lib/miden/swap/token-info';
import { hapticLight } from 'lib/mobile/haptics';

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
    >
      {/* A sheet's facts, as the network sheet sets them; led by the swap action's own glyph and colour. */}
      <ListGroup as="ul" surface="plain" insetHairlines className="px-4">
        <FactRow
          as="li"
          titleAs="h3"
          leading={
            <IconCircle className="text-action-swap">
              <Icon name={IconName.Convert} fill="currentColor" />
            </IconCircle>
          }
          title={t('swapExecutionTitle')}
          description={t(info.executionKey)}
        />
      </ListGroup>
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
      <InfoHintTrigger
        data-testid="swap-token-info-button"
        label={t('tokenInfoLabel', { token: label })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          hapticLight();
          setOpen(true);
        }}
      />
      <SwapTokenInfoSheet open={open} onOpenChange={setOpen} label={label} info={info} />
    </>
  );
};
