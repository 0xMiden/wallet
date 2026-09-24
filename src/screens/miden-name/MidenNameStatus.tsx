import React, { FC, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { FlowLayout } from 'components/flow/FlowLayout';
import { Hero } from 'components/ui/Hero';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { Spinner } from 'components/ui/Spinner';
import type { ITransaction } from 'lib/miden/db/types';
import { useAllAccounts } from 'lib/miden/front';
import { useMidenContext } from 'lib/miden/front/client';
import { MIDEN_METADATA } from 'lib/miden/metadata/defaults';
import { formatMidenName } from 'lib/miden/name/encoding';
import { publishRegistryRecord } from 'lib/miden/name/nfa';
import {
  phaseOf,
  publishNameInputsOf,
  publishPhaseOf,
  registerNameInputsOf,
  useMidenNamePublishes
} from 'lib/miden/name/registrations';
import { useMidenNameRecord } from 'lib/miden/name/useMidenNameRecord';
import { initiateConsumeTransactionFromId, tagConsumeAsMidenNameClaim } from 'lib/miden/transaction/initiate';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { formatAmount } from 'lib/shared/format';
import { useConfirm } from 'lib/ui/dialog';
import { cn } from 'lib/ui/util';
import { navigate, Redirect } from 'lib/woozie';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';
import type { TransactionHeroState } from 'screens/generating-transaction/types';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';
import { truncateAddress } from 'utils/string';

import { startMidenNameProcessing } from './processing';
import { canPublish, claimNeedsRetry, failureKeyOf, type MidenNameStepState, stepsFor } from './steps';

interface MidenNameStatusProps {
  txId: string;
}

/** The circle at the start of a step row: check, spinner, empty ring or cross. */
const StepIndicator: FC<{ state: MidenNameStepState }> = ({ state }) => {
  const content = (() => {
    switch (state) {
      case 'complete':
        return (
          <span className="flex size-5 items-center justify-center rounded-full bg-status-positive text-pure-white">
            <Icon name={IconName.Checkmark} size="xs" fill="currentColor" />
          </span>
        );
      case 'active':
        return <Spinner size="sm" />;
      case 'failed':
        return (
          <span className="flex size-5 items-center justify-center rounded-full bg-status-negative text-pure-white">
            <Icon name={IconName.Close} size="xs" fill="currentColor" />
          </span>
        );
      default:
        return <span className="size-5 rounded-full border-2 border-hairline" />;
    }
  })();
  return (
    <span data-state={state} className="flex size-5 items-center justify-center">
      {content}
    </span>
  );
};

/** The newest publish row of the label. The list is newest first. */
function publishRowOf(rows: ITransaction[], label: string | undefined): ITransaction | undefined {
  if (label === undefined) return undefined;
  return rows.find(row => publishNameInputsOf(row)?.label === label);
}

/** One key per publish row phase: the record read runs again when a publish moves forward. */
function publishRefreshKeyOf(rows: ITransaction[]): string {
  return rows.map(row => `${publishNameInputsOf(row)?.label ?? ''}:${publishPhaseOf(row)}`).join('|');
}

function heroStateOf(phaseFailed: boolean, owned: boolean): TransactionHeroState {
  switch (true) {
    case owned:
      return 'success';
    case phaseFailed:
      return 'failed';
    default:
      return 'processing';
  }
}

/**
 * The progress page of one Miden Name registration. It observes the
 * `register-name` row by id and the consume row that claims the name.
 */
export const MidenNameStatus: FC<MidenNameStatusProps> = ({ txId }) => {
  const { t } = useTranslation();
  const { signTransaction } = useMidenContext();
  const confirm = useConfirm();
  const accounts = useAllAccounts();
  const { row, loaded } = useTransactionRow(txId);
  const inputs = row ? registerNameInputsOf(row) : undefined;

  // The consume row of a retry that this page started. The tracker links it to
  // the registration on its next pass; until then the page follows it here.
  const [retryTxId, setRetryTxId] = useState<string>();
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string>();
  const { row: claimRow } = useTransactionRow(retryTxId ?? inputs?.claimTxId ?? '');

  // The publish of the name to the registry: the newest publish row of the
  // label, and the registry record read from the chain (a record published
  // from an other device is visible only there).
  const publishRows = useMidenNamePublishes(row?.accountId);
  const publishRow = publishRowOf(publishRows, inputs?.label);
  const ownedNow = row !== undefined && phaseOf(row) === 'owned';
  const record = useMidenNameRecord(
    row?.accountId,
    ownedNow ? inputs?.label : undefined,
    publishRefreshKeyOf(publishRows)
  );
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string>();

  const onDone = () => navigate('/');

  if (loaded && (!row || !inputs)) return <Redirect to="/" />;
  if (!row || !inputs) {
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );
  }

  const phase = phaseOf(row);
  const publish = { row: publishRow, record };
  const steps = stepsFor(row, claimRow, publish);
  const needsRetry = claimNeedsRetry(row, claimRow);
  const failureKey = failureKeyOf(row, claimRow);
  const owned = phase === 'owned';
  const showPublish = canPublish(row, publish);
  const terminal = owned || (phase === 'failed' && !needsRetry);
  const heroState = heroStateOf(failureKey !== undefined, owned);
  const accountName =
    accounts.find(account => account.publicKey === row.accountId)?.name ?? truncateAddress(row.accountId);
  const price = `${formatAmount(BigInt(inputs.priceBaseUnits), MIDEN_METADATA.decimals)} ${MIDEN_METADATA.symbol}`;

  const handleRetryClaim = async () => {
    const deliveryNoteId = inputs.deliveryNoteId;
    if (isRetrying || !deliveryNoteId) return;
    setIsRetrying(true);
    setRetryError(undefined);
    try {
      // `manualRetry: true`: the user asked for this claim, so the retry backoff must not refuse it.
      const claimTxId = await initiateConsumeTransactionFromId(
        row.accountId,
        deliveryNoteId,
        isDelegateProofEnabled(),
        true
      );
      // Without the tag the tracker does not see this consume as the claim of the registration.
      await tagConsumeAsMidenNameClaim(claimTxId, inputs.label, row.id);
      setRetryTxId(claimTxId);
      startMidenNameProcessing(signTransaction);
    } catch (error) {
      console.error('[miden-name] claim retry failed', error);
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRetrying(false);
    }
  };

  const handlePublish = async () => {
    if (isPublishing || !showPublish) return;
    // A publish reveals the owner. Ask first, in the wallet's confirm sheet.
    const accepted = await confirm({
      title: t('midenNameStepPublishing'),
      children: t('midenNamePublishExplainer', { name: formatMidenName(inputs.label) }),
      confirmLabel: t('midenNamePublish')
    });
    if (!accepted) return;
    setIsPublishing(true);
    setPublishError(undefined);
    try {
      const publishTxId = await publishRegistryRecord(row.accountId, inputs.label);
      startMidenNameProcessing(signTransaction);
      navigate(`/generating-transaction/${encodeURIComponent(publishTxId)}`);
    } catch (error) {
      console.warn('[miden-name] Publish to registry failed:', error);
      setPublishError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-app-bg" data-testid="miden-name-status-page">
      <FlowLayout
        title={t('midenName')}
        onClose={onDone}
        footer={
          <div className="flex w-full flex-col gap-2.5">
            {retryError && (
              <p role="alert" className="text-center text-caption text-negative-ink">
                {retryError}
              </p>
            )}
            {publishError && (
              <p
                role="alert"
                className="text-center text-caption text-negative-ink"
                data-testid="miden-name-publish-error"
              >
                {publishError}
              </p>
            )}
            {showPublish && (
              <Button
                data-testid="miden-name-publish"
                variant={ButtonVariant.Primary}
                title={t('midenNamePublish')}
                onClick={handlePublish}
                isLoading={isPublishing}
                disabled={isPublishing}
                className="w-full max-w-none"
              />
            )}
            {needsRetry && (
              <Button
                data-testid="miden-name-retry-claim"
                variant={ButtonVariant.Primary}
                title={t('midenNameRetryClaim')}
                onClick={handleRetryClaim}
                isLoading={isRetrying}
                disabled={isRetrying}
                className="w-full max-w-none"
              />
            )}
            <Button
              data-testid="miden-name-status-done"
              variant={terminal && !showPublish ? ButtonVariant.Primary : ButtonVariant.Secondary}
              title={terminal ? t('midenNameDone') : t('hide')}
              onClick={onDone}
              className="w-full max-w-none"
            />
          </div>
        }
      >
        <section className="flex flex-col gap-5 pt-4 pb-4">
          <Hero
            visual={<TransactionHeroIcon state={heroState} />}
            name={formatMidenName(inputs.label)}
            subtitle={t('midenNameStatusSubtitle', { amount: price, account: accountName })}
            data-testid="miden-name-status-hero"
          />

          <ListGroup data-testid="miden-name-steps">
            {steps.map(step => (
              <ListRow
                key={step.id}
                icon={<StepIndicator state={step.state} />}
                title={<span className={cn(step.state === 'pending' && 'text-muted')}>{t(step.labelKey)}</span>}
                value={
                  step.durationSec !== undefined
                    ? t('transactionStepDurationSec', { seconds: String(step.durationSec) })
                    : undefined
                }
                data-testid={`miden-name-step-${step.id}`}
              />
            ))}
          </ListGroup>

          {failureKey && (
            <Notice tone="negative" data-testid="miden-name-failure">
              {t(failureKey)}
            </Notice>
          )}
        </section>
      </FlowLayout>
    </div>
  );
};

export default MidenNameStatus;
