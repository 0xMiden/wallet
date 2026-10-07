import React, { FC, ReactNode } from 'react';

import { useTranslation } from 'react-i18next';

import { useHideForegroundDappWhileOpen } from 'app/providers/DappBrowserProvider';
import { Button } from 'components/Button';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

type DescriptionVariant = 'caption' | 'message';

export interface AcknowledgeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the sheet's overlay screen-key segment (`drawer:<screenKey>`). E2E-only. */
  screenKey: string;
  /** The sheet's test id; its scroll body and its CTA take `<testId>-body` and `<testId>-cta`. */
  testId: string;
  title: ReactNode;
  description: ReactNode;
  /** `message` for a description that is the sheet's whole message; `caption` (the drawer's) otherwise. */
  descriptionVariant?: DescriptionVariant;
  /** Scrolls with the header and description, above the pinned CTA. */
  children?: ReactNode;
}

const descriptionClassName: Record<DescriptionVariant, string | undefined> = {
  caption: undefined,
  // 16px, a size up from the drawer's caption, in the heading face: it is the sheet's whole message.
  message: 'face-heading text-body-strong'
};

/**
 * A sheet whose only action is "I understand", which closes it. The caller owns `open`.
 */
export const AcknowledgeSheet: FC<AcknowledgeSheetProps> = ({
  open,
  onOpenChange,
  screenKey,
  testId,
  title,
  description,
  descriptionVariant = 'caption',
  children
}) => {
  const { t } = useTranslation();

  // A foregrounded dApp's native window sits above the host WebView and would cover the sheet; the
  // provider hides it while this holds.
  useHideForegroundDappWhileOpen(open);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey={screenKey}>
      {/* The body scrolls and the CTA stays pinned: the sheet can outgrow DrawerContent's 80vh cap in
          the 360x600 popup and in long locales. */}
      <DrawerContent className="pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid={`${testId}-body`}>
            <DrawerHeader>
              <DrawerTitle>{title}</DrawerTitle>
            </DrawerHeader>
            <DrawerDescription className={descriptionClassName[descriptionVariant]}>{description}</DrawerDescription>
            {children}
          </div>
          {/* The shared Button fires its own tap haptic. */}
          <DrawerFooter className="shrink-0">
            <Button
              title={t('iUnderstand')}
              onClick={() => onOpenChange(false)}
              className="w-full"
              data-testid={`${testId}-cta`}
            />
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
};
