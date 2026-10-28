import React from 'react';

import { useTranslation } from 'react-i18next';

import { DappOrigin } from 'components/ui/DappOrigin';

/**
 * Who asked for this approval. Full width, and tinted so it is not another From card.
 * The origin is the only name shown: a dApp-supplied title is not trusted.
 */
export const OriginatorChip: React.FC<{
  origin: string;
  testId?: string;
  /** Wraps the origin when it is the dialog title. The label stays outside that heading. */
  titleWrap?: (name: React.ReactNode) => React.ReactNode;
}> = ({ origin, testId, titleWrap }) => {
  const { t } = useTranslation();
  const name = <DappOrigin origin={origin} className="tx-originator-name" data-testid={testId} />;
  return (
    <div className="tx-originator">
      <div className="tx-story-role">{t('originator')}</div>
      {titleWrap ? titleWrap(name) : name}
    </div>
  );
};
