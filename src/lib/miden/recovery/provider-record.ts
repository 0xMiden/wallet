import { z } from 'zod';

export const recoveryText = z.string().min(1).max(2048);
export const recoveryTime = z.number().int().nonnegative().safe();
const text = recoveryText;
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const decimals = z.number().int().min(0).max(38);
const evmAddress = z.custom<`0x${string}`>(value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value));
const strings = z.array(text).max(256);
const boundedString = z.string().max(2048);
const fee = z.object({ recipient: text, fee: z.number().finite().nonnegative() }).strict();
const asset = z
  .object({
    assetId: text,
    blockchain: text,
    symbol: text,
    decimals,
    coingeckoId: text.optional(),
    contractAddress: text.optional(),
    faucetId: text.optional(),
    chainId: recoveryTime.optional()
  })
  .strict();
const config = z
  .object({
    serviceUrl: text,
    midenAssets: z.array(z.object({ assetId: text, faucetId: text, decimals }).strict()).max(256),
    evmAssets: z
      .array(
        z
          .object({
            assetId: text,
            blockchain: text,
            chainId: recoveryTime,
            contractAddress: text,
            decimals,
            symbol: text
          })
          .strict()
      )
      .max(256)
      .optional(),
    appFees: z.array(fee).max(256).optional()
  })
  .strict();
const quoteRequest = z
  .object({
    dry: z.boolean(),
    swapType: z.literal('EXACT_INPUT'),
    slippageTolerance: recoveryTime,
    originAsset: text,
    depositType: z.literal('ORIGIN_CHAIN'),
    destinationAsset: text,
    amount: uint,
    refundTo: text,
    refundType: z.literal('ORIGIN_CHAIN'),
    recipient: text,
    recipientType: z.literal('DESTINATION_CHAIN'),
    deadline: text,
    quoteWaitingTimeMs: recoveryTime.optional(),
    referral: text.optional(),
    virtualChainRecipient: text.optional(),
    virtualChainRefundRecipient: text.optional(),
    customRecipientMsg: boundedString.optional(),
    sessionId: text.optional(),
    connectedWallets: strings.optional(),
    correlationId: text.optional(),
    appFees: z.array(fee).max(256).optional(),
    confidentiality: z.enum(['public', 'basic', 'advanced']).optional(),
    insured: z.boolean().optional(),
    partnerId: text.optional(),
    userAccountId: text.optional(),
    depositMode: z.enum(['SIMPLE', 'MEMO']).optional()
  })
  .strict();
const quote = z
  .object({
    correlationId: text,
    timestamp: text,
    signature: text,
    quoteRequest,
    quote: z
      .object({
        depositAddress: text.optional(),
        depositMemo: boundedString.optional(),
        amountIn: uint,
        amountInFormatted: text,
        amountInUsd: text,
        minAmountIn: uint,
        amountOut: uint,
        amountOutFormatted: text,
        amountOutUsd: text,
        minAmountOut: uint,
        deadline: text.optional(),
        timeWhenInactive: text.optional(),
        timeEstimate: recoveryTime,
        refundFee: text.optional(),
        withdrawFee: text.optional(),
        virtualChainRecipient: text.optional(),
        virtualChainRefundRecipient: text.optional(),
        customRecipientMsg: boundedString.optional()
      })
      .strict()
  })
  .strict();
const status = z.enum([
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED'
]);
const transactions = z.array(z.object({ hash: text, explorerUrl: text }).strict()).max(256);
export const recoveryOneClick = z
  .object({
    direction: z.enum(['miden-to-evm', 'evm-to-miden']),
    request: z
      .object({
        amount: uint,
        originAsset: asset,
        destinationAsset: asset,
        refundTo: text,
        recipient: text,
        deadline: text,
        slippageTolerance: recoveryTime
      })
      .strict(),
    quote,
    config,
    network: text,
    accountId: text,
    accountAddress: text,
    originAsset: asset,
    destinationAsset: asset,
    faucetId: text,
    amount: uint,
    phase: z.enum([
      'depositing',
      'known-deposit-tx',
      'pending-deposit',
      'processing',
      'arriving',
      'delivered',
      'refunded',
      'incomplete-deposit',
      'failed'
    ]),
    depositAddress: text.optional(),
    depositMemo: boundedString.optional(),
    originTransactionHash: text.optional(),
    destinationNoteIds: strings.optional(),
    providerStatus: status.optional(),
    providerSubmitted: z.boolean().optional(),
    evmSubmission: z.enum(['not-started', 'attempted', 'known']).optional(),
    fundingDeadline: text.optional(),
    updatedAt: recoveryTime.optional(),
    statusResponse: z
      .object({
        correlationId: text,
        quoteResponse: quote,
        status,
        updatedAt: text,
        swapDetails: z
          .object({
            intentHashes: strings,
            nearTxHashes: strings,
            amountIn: uint.optional(),
            amountOut: uint.optional(),
            originChainTxHashes: transactions,
            destinationChainTxHashes: transactions,
            refundedAmount: uint.optional(),
            refundReason: boundedString.optional(),
            depositedAmount: uint.optional()
          })
          .strict()
      })
      .strict()
      .optional()
  })
  .superRefine((value, context) => {
    const signed = value.quote.quoteRequest;
    const request = value.request;
    const confirmedOutput =
      value.statusResponse?.status === 'SUCCESS' ? value.statusResponse.swapDetails.amountOut : undefined;
    const amountBound =
      value.direction === 'evm-to-miden'
        ? value.amount === value.quote.quote.amountOut ||
          (confirmedOutput !== undefined &&
            BigInt(confirmedOutput) > 0n &&
            BigInt(confirmedOutput) >= BigInt(value.quote.quote.minAmountOut) &&
            value.amount === BigInt(confirmedOutput).toString())
        : value.amount === value.quote.quote.amountIn;
    const bound =
      signed.amount === request.amount &&
      signed.originAsset === request.originAsset.assetId &&
      signed.destinationAsset === request.destinationAsset.assetId &&
      signed.refundTo === request.refundTo &&
      signed.recipient === request.recipient &&
      signed.deadline === request.deadline &&
      signed.slippageTolerance === request.slippageTolerance &&
      value.originAsset.assetId === request.originAsset.assetId &&
      value.destinationAsset.assetId === request.destinationAsset.assetId &&
      value.depositAddress === value.quote.quote.depositAddress &&
      value.depositMemo === value.quote.quote.depositMemo &&
      value.quote.quote.amountIn === request.amount &&
      amountBound &&
      (!value.statusResponse ||
        (value.statusResponse.correlationId === value.quote.correlationId &&
          JSON.stringify(value.statusResponse.quoteResponse) === JSON.stringify(value.quote)));
    if (!bound) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Recovery quote binding mismatch' });
  });

const rpcUrls = z.object({ http: z.array(text).min(1).max(8), webSocket: z.array(text).max(8).optional() }).strict();
const chain = z
  .object({
    id: recoveryTime,
    name: text,
    nativeCurrency: z.object({ name: text, symbol: text, decimals }).strict(),
    rpcUrls: z.object({ default: rpcUrls }).strict(),
    testnet: z.boolean().optional(),
    blockExplorers: z
      .object({ default: z.object({ name: text, url: text, apiUrl: text.optional() }).strict() })
      .strict()
      .optional()
  })
  .strict();
const source = { chain, usdc: evmAddress, domain: recoveryTime, midenDomain: recoveryTime.optional() };
export const recoveryUsdcxSource = z.discriminatedUnion('route', [
  z.object({ ...source, route: z.literal('xreserve'), xReserve: evmAddress, attestationApi: text }).strict(),
  z
    .object({
      ...source,
      route: z.literal('cctp-executor'),
      tokenMessengerWithFees: evmAddress,
      irisApi: text,
      target: z
        .object({
          ...source,
          executor: evmAddress,
          handler: evmAddress,
          xReserve: evmAddress,
          attestationApi: text,
          irisApi: text
        })
        .strict()
    })
    .strict()
]);

export const recoveryCompactRequest = z
  .object({
    chainId: uint,
    isRegisteredOnchain: z.boolean(),
    sponsorSignature: z.literal('0x'),
    witnessTypeString: text,
    routingAndLiquidityOptions: z
      .discriminatedUnion('preset', [
        z.object({ preset: z.literal('any') }).strict(),
        z.object({ preset: z.literal('filler-single-transaction') }).strict(),
        z.object({ preset: z.literal('external-multi-transactions') }).strict(),
        z.object({ preset: z.literal('custom'), solvers: z.array(evmAddress).max(256) }).strict()
      ])
      .optional(),
    compact: z
      .object({
        arbiter: evmAddress,
        sponsor: evmAddress,
        nonce: uint,
        expires: uint,
        id: uint,
        lockTag: text,
        token: text,
        amount: uint,
        mandate: z
          .object({
            tokenIn: text,
            tokenInAmount: uint,
            tokenOut: text,
            minTokenOut: uint,
            destinationChainId: uint,
            taskType: text,
            recipient: text,
            protocolHashIdentifier: text.optional(),
            marketUid: text.optional(),
            action: text.optional(),
            payAsset: text.optional(),
            isAll: z.boolean().optional(),
            simulate: z.boolean().optional(),
            midenRecipientAccount: text.optional(),
            midenSourceAccount: text.optional(),
            midenFaucetId: text.optional(),
            midenNoteType: text.optional(),
            midenNoteId: boundedString.optional(),
            midenReclaimHeight: uint.optional()
          })
          .strict()
      })
      .strict()
  })
  .strict();
export const recoveryPreparedExecution = z
  .object({
    chainId: recoveryTime,
    attemptId: text,
    allocations: z
      .array(
        z
          .object({
            sponsor: evmAddress,
            nonce: uint,
            expires: uint,
            requestJson: z
              .string()
              .min(1)
              .max(1_000_000)
              .superRefine((value, context) => {
                try {
                  recoveryCompactRequest.parse(JSON.parse(value));
                } catch {
                  context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid recovery allocation' });
                }
              })
          })
          .strict()
      )
      .min(1)
      .max(256),
    delivery: z
      .object({
        allocationIndex: recoveryTime,
        owner: evmAddress,
        nonce: uint,
        destinationChainId: recoveryTime,
        recipientAccountId: text,
        destinationFaucetId: text
      })
      .strict()
  })
  .strict();

export const recoveryEpochExecution = z
  .object({
    requestJson: z
      .string()
      .min(1)
      .max(1_000_000)
      .superRefine((value, context) => {
        try {
          recoveryCompactRequest.parse(JSON.parse(value));
        } catch {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid retained Epoch request' });
        }
      }),
    claimHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    resourceLockRequired: z.boolean(),
    collateralType: z.enum(['evm', 'miden']),
    submission: z.enum(['prepared', 'allocation-attempted', 'accepted']),
    allocation: z
      .object({ hash: recoveryText, signature: recoveryText, digest: recoveryText, nonce: uint.optional() })
      .strict()
      .optional(),
    executionTransactions: z
      .array(
        z
          .object({
            target: evmAddress,
            callData: z
              .string()
              .regex(/^0x[0-9a-fA-F]*$/)
              .max(1_000_000),
            value: uint,
            chainId: recoveryTime
          })
          .strict()
      )
      .max(256)
      .optional(),
    transactionHashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).max(256),
    batchIds: strings
  })
  .strict();
