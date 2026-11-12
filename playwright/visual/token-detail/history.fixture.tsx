import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ActivityRow, Card } from 'components/ui';

export default function History() {
  const { t } = useTranslation();

  return (
    <Card asChild surface="outline" padding="row" className="relative">
      <ActivityRow
        testId="token-history-fixture-row"
        icon={<Icon name={IconName.Receive} size="sm" className="text-pure-white" />}
        iconBg="bg-tx-received"
        title={t('received')}
        subtitle={t('testnet')}
        amount={{ value: '+0.25', symbol: 'IETH', direction: 'positive' }}
        status="received"
      />
    </Card>
  );
}
