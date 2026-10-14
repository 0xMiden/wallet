import React, { useCallback, useRef } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button } from 'components/ui/Button';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { radioGroupKeyTarget } from 'components/ui/radio-group-keys';
import { usePreset } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

/** How the note that carries a send is stored on chain: hidden (the default) or readable by anyone. */
export type TransferType = 'private' | 'public';

const TRANSFER_TYPES: readonly TransferType[] = ['private', 'public'];

export interface TransferTypeDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: TransferType;
  onChange: (value: TransferType) => void;
}

/**
 * The review page's "Transfer type" sheet: one choice between a private and a public note. The
 * choice applies as it is tapped (the row behind the sheet updates at once) and Done only closes;
 * what a public note reveals is spelled out under the group while Public is the choice, since that
 * is the one consequence worth reading before sending.
 */
export const TransferTypeDrawer: React.FC<TransferTypeDrawerProps> = ({ open, onOpenChange, value, onChange }) => {
  const { t } = useTranslation();
  const reveal = usePreset('reveal');
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const select = useCallback(
    (next: TransferType) => {
      if (next === value) return;
      hapticSelection();
      onChange(next);
    },
    [onChange, value]
  );

  // A radiogroup: arrows, Home and End move focus and the choice together (the choice has no
  // side effect beyond the sheet, so selection may follow focus).
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const target = radioGroupKeyTarget(event.key, TRANSFER_TYPES.length, index);
      if (target === null) return;
      event.preventDefault();
      rowsRef.current[target]?.focus();
      const next = TRANSFER_TYPES[target];
      if (next !== undefined) select(next);
    },
    [select]
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="transfer-type">
      <DrawerContent className="pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <div className="flex min-h-0 flex-1 flex-col" data-testid="transfer-type-drawer">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DrawerHeader>
              <DrawerTitle>{t('transferType')}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4 pt-2">
              <div role="radiogroup" aria-label={t('transferType')}>
                <ListGroup>
                  {TRANSFER_TYPES.map((type, index) => {
                    const selected = type === value;
                    return (
                      <ListRow
                        key={type}
                        ref={node => {
                          rowsRef.current[index] = node;
                        }}
                        radio
                        checked={selected}
                        tabIndex={selected ? 0 : -1}
                        onKeyDown={event => handleKeyDown(event, index)}
                        // The pick buzzes itself, and only when it changes: see `select`.
                        haptic={false}
                        onClick={() => select(type)}
                        title={t(type)}
                        value={type === 'private' ? t('default') : undefined}
                        data-testid={`transfer-type-${type}`}
                      />
                    );
                  })}
                </ListGroup>
              </div>
              <AnimatePresence initial={false}>
                {value === 'public' && (
                  <motion.div key="public-help" className="overflow-hidden" {...reveal}>
                    <div className="flex flex-col gap-2 px-1 pt-3" data-testid="transfer-type-public-help">
                      <p className="text-caption text-ink">{t('publicTransferHelp')}</p>
                      <p className="text-caption text-muted">{t('senderAddressPublicNote')}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
          {/* The shared Button fires its own tap haptic. */}
          <DrawerFooter className="shrink-0">
            <Button
              title={t('done')}
              accent="send"
              onClick={() => onOpenChange(false)}
              className="w-full max-w-none"
              data-testid="transfer-type-done"
            />
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
};
