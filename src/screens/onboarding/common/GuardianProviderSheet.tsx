import React from 'react';

import { useTranslation } from 'react-i18next';

import type { GuardianProbeVerdict } from 'app/hooks/useGuardianAvailability';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { ChoiceCardGroup, ChoiceCardItem } from 'components/ui/ChoiceCard';
import { Pill } from 'components/ui/Pill';
import { StatusBadge } from 'components/ui/StatusBadge';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

/**
 * Who each listed operator is, in words: `about` is the sentence the guardian step shows under the
 * chosen operator's name, `kind` the short line on its card in this sheet. An operator missing here
 * falls back to its `operatedBy`.
 */
const GUARDIAN_OPERATOR_COPY: Record<string, { aboutKey: string; kindKey: string }> = {
  'open-zeppelin': { aboutKey: 'guardianAboutOpenZeppelin', kindKey: 'guardianKindOpenZeppelin' },
  gateway: { aboutKey: 'guardianAboutGateway', kindKey: 'guardianKindGateway' },
  'lambda-class': { aboutKey: 'guardianAboutLambdaClass', kindKey: 'guardianKindLambdaClass' },
  kodax: { aboutKey: 'guardianAboutKodax', kindKey: 'guardianKindKodax' }
};

export const guardianOperatorCopy = (id: string) => GUARDIAN_OPERATOR_COPY[id];

export interface GuardianProviderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: readonly ResolvedGuardianOption[];
  /** Each operator's latest ping verdict by endpoint; undefined while its round is out. */
  verdicts: Readonly<Record<string, GuardianProbeVerdict | undefined>>;
  /** The operator the step locked in as fastest, tagged so the user sees why it was picked. */
  fastestId: string | null;
  /** The step's chosen operator. */
  value: string | null;
  /** A card was chosen: the step takes it and the sheet closes. */
  onPick: (id: string) => void;
}

/**
 * The guardian step's Change provider sheet: every operator on the network as a choice card, its logo,
 * name, what kind of company runs it and where. Choosing one is the whole decision, so the sheet closes
 * on the tap with no Select button. An operator that answered offline cannot be chosen, as on the picker.
 */
export const GuardianProviderSheet: React.FC<GuardianProviderSheetProps> = ({
  open,
  onOpenChange,
  options,
  verdicts,
  fastestId,
  value,
  onPick
}) => {
  const { t } = useTranslation();

  const pick = (id: string) => {
    onPick(id);
    onOpenChange(false);
  };

  const items: ChoiceCardItem[] = options.map(option => {
    const copy = guardianOperatorCopy(option.id);
    const isOffline = verdicts[option.endpoint]?.status === 'offline';
    const isFastest = option.id === fastestId;
    return {
      id: option.id,
      title: option.name,
      // The region is kept on one line: a break inside "EU-NORTH" reads as two words.
      subtitle: (
        <>
          {copy ? t(copy.kindKey) : option.operatedBy}
          {' · '}
          <span className="whitespace-nowrap">{option.location}</span>
        </>
      ),
      leading: <GuardianLogoTile guardianId={option.id} />,
      badge:
        isFastest || isOffline ? (
          <>
            {isFastest && (
              <Pill size="xs" tone="inactive">
                {t('guardianFastest')}
              </Pill>
            )}
            {isOffline && <StatusBadge status="offline" />}
          </>
        ) : undefined,
      disabled: isOffline,
      data: { 'data-guardian-endpoint': option.endpoint }
    };
  });

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="guardian-provider">
      <DrawerContent
        data-testid="meet-guardian-provider-sheet"
        className="max-h-[85vh] pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
      >
        <DrawerHeader>
          <DrawerTitle>{t('guardianProviderSheetTitle')}</DrawerTitle>
        </DrawerHeader>
        <DrawerDescription>{t('guardianProviderSheetDescription')}</DrawerDescription>

        <div className="no-scrollbar flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-4">
          <ChoiceCardGroup
            items={items}
            value={value}
            onChange={pick}
            onReselect={pick}
            aria-label={t('guardianProviderSheetTitle')}
          />
          <p className="text-center text-caption text-muted">{t('guardianProviderSheetFootnote')}</p>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default GuardianProviderSheet;
