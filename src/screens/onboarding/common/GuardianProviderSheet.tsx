import React, { useCallback } from 'react';

import { useTranslation } from 'react-i18next';

import type { GuardianProbeVerdict } from 'app/hooks/useGuardianAvailability';
import { ChoiceCardGroup, ChoiceCardItem } from 'components/ui/ChoiceCard';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { guardianOperatorCard } from './guardian-operator-card';

/**
 * The bundled words for the operators the wallet ships with, by id: `about` is the sentence the guardian
 * step shows under the chosen operator's name, `kind` the short line on its card in this sheet. The
 * config document's own text for an operator comes first (`useGuardianOperatorText`).
 */
const GUARDIAN_OPERATOR_COPY: Record<string, { aboutKey: string; kindKey: string }> = {
  'open-zeppelin': { aboutKey: 'guardianAboutOpenZeppelin', kindKey: 'guardianKindOpenZeppelin' },
  gateway: { aboutKey: 'guardianAboutGateway', kindKey: 'guardianKindGateway' },
  'lambda-class': { aboutKey: 'guardianAboutLambdaClass', kindKey: 'guardianKindLambdaClass' },
  kodax: { aboutKey: 'guardianAboutKodax', kindKey: 'guardianKindKodax' }
};

export const guardianOperatorCopy = (id: string) => GUARDIAN_OPERATOR_COPY[id];

export interface GuardianOperatorText {
  about: string;
  kind: string;
}

/**
 * Who an operator is, in words. Each line is the config document's English text for the operator, else
 * the bundled text for its id in the user's language, else its `operatedBy`.
 */
export function useGuardianOperatorText(): (option: ResolvedGuardianOption) => GuardianOperatorText {
  const { t } = useTranslation();
  return useCallback(
    (option: ResolvedGuardianOption) => {
      const bundled = guardianOperatorCopy(option.id);
      const line = (text: string | undefined, bundledKey: string | undefined): string => {
        if (text) return text;
        if (bundledKey) return t(bundledKey);
        return option.operatedBy;
      };
      return { about: line(option.about, bundled?.aboutKey), kind: line(option.kind, bundled?.kindKey) };
    },
    [t]
  );
}

export interface GuardianProviderSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: readonly ResolvedGuardianOption[];
  /** Each operator's latest ping verdict by endpoint; undefined while its round is out. */
  verdicts: Readonly<Record<string, GuardianProbeVerdict | undefined>>;
  /**
   * The fastest operator of the step's first full round with one online, tagged so the user sees why it was
   * picked. A later round never moves it, so after a pick of the user's it can name another operator.
   */
  fastestId: string | null;
  /** The step's chosen operator. */
  value: string | null;
  /** A card was chosen: the step takes it and the sheet closes. */
  onPick: (id: string) => void;
}

/**
 * The guardian step's Change provider sheet: every operator on the network as a choice card, its logo,
 * name, what kind of company runs it and where. Choosing one is the whole decision, so the sheet closes
 * on the tap with no Select button, and the arrow keys only move between operators until Enter or Space
 * chooses one. An operator that answered offline cannot be chosen, as on the picker.
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
  const operatorText = useGuardianOperatorText();

  const pick = (id: string) => {
    onPick(id);
    onOpenChange(false);
  };

  const items: ChoiceCardItem[] = options.map(option => {
    return guardianOperatorCard({
      option,
      // The region is kept on one line: a break inside "EU-NORTH" reads as two words.
      subtitle: (
        <>
          {operatorText(option).kind}
          {' · '}
          <span className="whitespace-nowrap">{option.location}</span>
        </>
      ),
      tag: option.id === fastestId ? t('guardianFastest') : undefined,
      offline: verdicts[option.endpoint]?.status === 'offline'
    });
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
            arrowKeys="focus"
            aria-label={t('guardianProviderSheetTitle')}
          />
          <p className="text-center text-caption text-muted">{t('guardianProviderSheetFootnote')}</p>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default GuardianProviderSheet;
