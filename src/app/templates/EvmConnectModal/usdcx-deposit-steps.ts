import { IBridgedReceivePhase, IUsdcxCctpLeg } from 'lib/miden/db/types';
import { isCctpForwardFailed } from 'lib/usdcx/cctp';
import { getUsdcxSourceChains } from 'lib/usdcx/chains';
import { getChain } from 'lib/walletconnect/config';
import type { TransactionStepState } from 'screens/generating-transaction/types';

/** One step of a USDCx deposit, as the status screen and the Activity detail list them. */
export interface UsdcxDepositStep {
  id: 'source' | 'burn-attested' | 'execute' | 'deposit-attested' | 'minted';
  /** The i18n key of the step's label; `network` names the chain where the step happens. */
  labelKey: string;
  network?: string;
  state: TransactionStepState;
}

export interface UsdcxDepositStepsInput {
  sourceChainId?: number;
  phase: IBridgedReceivePhase;
  cctp?: IUsdcxCctpLeg;
}

/**
 * The steps of a USDCx deposit and where it stands, derived from the row alone so every screen agrees.
 *
 * A direct xReserve deposit has three: the deposit on the source chain, Circle's attestation of it, and
 * the mint on Miden. An executor-route deposit has two more between the first and the second: Circle's
 * attestation of the CCTP burn, and the execute on Arc, which Circle does for a forwarded burn and the
 * user does otherwise. A failed row marks the step it was on as failed and leaves the rest pending.
 */
export function usdcxDepositSteps({ sourceChainId, phase, cctp }: UsdcxDepositStepsInput): UsdcxDepositStep[] {
  const failed = phase === 'failed';
  // The row draws with or without the bridge config: the chain's name is compiled, and only an executor deposit has
  // a CCTP leg. The config adds the executor chain's name, and tells the route before the burn is signed.
  const sourceName = sourceChainId === undefined ? undefined : getChain(sourceChainId)?.name;
  const source = sourceChainId === undefined ? undefined : getUsdcxSourceChains().get(sourceChainId);
  const executor = source?.route === 'cctp-executor' || cctp !== undefined;
  const targetName = source?.route === 'cctp-executor' ? source.target.chain.name : undefined;

  // Each flag is true once the step it names has happened; later phases imply the earlier steps.
  const sourceDone = phase !== 'submitting';
  const minted = phase === 'received';
  const depositAttested = minted || phase === 'ready';
  const executed = depositAttested || cctp?.executeTxHash !== undefined;
  const burnAttested = executed || cctp?.attestation !== undefined || cctp?.forwardState !== undefined;

  const stateOf = (done: boolean, previousDone: boolean): TransactionStepState => {
    if (done) return 'complete';
    if (!previousDone) return 'pending';
    return failed ? 'failed' : 'active';
  };

  const steps: UsdcxDepositStep[] = [
    {
      id: 'source',
      labelKey: executor ? 'usdcxStepBurned' : 'usdcxStepDeposited',
      network: sourceName,
      state: stateOf(sourceDone, true)
    }
  ];
  if (executor) {
    // A forwarded burn is Circle's to execute unless Circle gave up on it; a manual burn is the user's.
    const circleExecutes = cctp?.forwarded === true && !isCctpForwardFailed(cctp.forwardState);
    steps.push(
      { id: 'burn-attested', labelKey: 'usdcxStepBurnAttested', state: stateOf(burnAttested, sourceDone) },
      {
        id: 'execute',
        labelKey: circleExecutes ? 'usdcxStepCircleExecutes' : 'usdcxStepUserExecutes',
        network: targetName,
        state: stateOf(executed, burnAttested)
      }
    );
  }
  steps.push(
    {
      id: 'deposit-attested',
      labelKey: 'usdcxStepDepositAttested',
      state: stateOf(depositAttested, executor ? executed : sourceDone)
    },
    { id: 'minted', labelKey: 'usdcxStepMinted', state: stateOf(minted, depositAttested) }
  );
  return steps;
}
