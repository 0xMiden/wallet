import {
  AdviceMap,
  Felt,
  FeltArray,
  FungibleAsset,
  Note,
  NoteAssets,
  NoteAttachment,
  NoteMetadata,
  NoteRecipientArray,
  NoteTag,
  NoteType,
  Poseidon2,
  Word,
  type AccountId,
  type MidenClient,
  type TransactionRequest,
  type TransactionRequestBuilder
} from '@miden-sdk/miden-sdk';

import {
  checkedPayScript,
  feeOnlyScript,
  includesBytes,
  payScript,
  type PayParams,
  type ScriptKind
} from './custom-scripts.js';

/** The one fungible payment a pay script makes from the account that executes it. */
export interface ScriptPayment {
  sender: AccountId;
  target: AccountId;
  faucet: AccountId;
  amount: bigint;
  noteType: NoteType;
}

export interface BuiltScriptRequest {
  request: TransactionRequest;
  /** The note the script creates; undefined for `fee-only`. */
  predicted: Note | undefined;
  scriptRootHex: string;
  /** X8b's script argument, which also keys its advice words. */
  scriptArgHex: string | undefined;
  /** Self-checks through SDK accessors; the caller throws on any false one. */
  checks: Record<string, boolean>;
}

const random63 = (): bigint => {
  const values = new BigUint64Array(1);
  crypto.getRandomValues(values);
  // 63-bit values stay below the Goldilocks modulus, as guardian-request-builder.ts randomWord does.
  return (values[0] ?? 0n) & 0x7fff_ffff_ffff_ffffn;
};

// createP2IDNote always attaches the attachment it is given and a note id commits to its attachments (miden-protocol
// 0.17.1 src/note/note_id.rs:28-30), while create_note adds none: the prediction keeps that note's recipient and
// assets under attachment-free metadata.
function predictPayment(payment: ScriptPayment): Note {
  const assets = new NoteAssets([new FungibleAsset(payment.faucet, payment.amount)]);
  const p2id = Note.createP2IDNote(payment.sender, payment.target, assets, payment.noteType, new NoteAttachment());
  return new Note(
    p2id.assets(),
    new NoteMetadata(payment.sender, payment.noteType, NoteTag.withAccountTarget(payment.target)),
    p2id.recipient()
  );
}

function payParams(predicted: Note): PayParams {
  const [asset] = predicted.assets().fungibleAssets();
  if (asset === undefined) throw new Error('the predicted payment carries no fungible asset');
  return {
    recipientHex: predicted.recipient().digest().toHex(),
    tag: predicted.metadata().tag().asU32(),
    noteType: predicted.metadata().noteType() === NoteType.Public ? 1 : 0,
    assetIdHex: asset.vaultKey().toHex(),
    assetValueHex: asset.intoWord().toHex()
  };
}

/**
 * Compiles the `kind` script and attaches it to `builder`, a bare builder or the Guardian twin's fee-aware one. A
 * script request carries no own output notes, so the payment's recipient is declared instead: the host needs it to emit
 * a full note (miden-tx 0.17.1 src/host/note_builder.rs:48-60) and the wallet to relay a private one (complete.ts:126-138).
 */
export async function buildScriptRequest(
  client: MidenClient,
  builder: TransactionRequestBuilder,
  kind: ScriptKind,
  payment: ScriptPayment | undefined
): Promise<BuiltScriptRequest> {
  if ((kind === 'fee-only') !== (payment === undefined)) {
    throw new Error(`a ${kind} script ${payment === undefined ? 'needs' : 'takes no'} payment`);
  }
  const predicted = payment === undefined ? undefined : predictPayment(payment);
  const pay = predicted === undefined ? undefined : payParams(predicted);
  // X8b's eight felts: two words keyed in the advice map by their commitment, which is also the script argument. Each
  // SDK call takes fresh Felts, since the browser build consumes a handle passed by value.
  const values = kind === 'pay-checked' ? Array.from({ length: 8 }, () => random63()) : [];
  const felts = (from = 0, to = values.length) => values.slice(from, to).map(value => new Felt(value));
  const commitment = values.length === 0 ? undefined : Poseidon2.hashElements(new FeltArray(felts()));
  const scriptArgHex = commitment?.toHex();
  const code =
    pay === undefined
      ? feeOnlyScript()
      : scriptArgHex === undefined
        ? payScript(pay)
        : checkedPayScript(pay, {
            scriptArgHex,
            adviceWordsHex: [Word.newFromFelts(felts(0, 4)).toHex(), Word.newFromFelts(felts(4, 8)).toHex()]
          });
  const script = await client.compile.txScript({ code });
  let next = builder.withCustomScript(script);
  if (predicted !== undefined)
    next = next.withExpectedOutputRecipients(new NoteRecipientArray([predicted.recipient()]));
  if (commitment !== undefined) {
    const advice = new AdviceMap();
    advice.insert(commitment, new FeltArray(felts()));
    next = next.withScriptArg(commitment).extendAdviceMap(advice);
  }
  const request = next.build();
  const checks: Record<string, boolean> = {
    // A script emits the notes, never the request (miden-client 0.17.3 src/transaction/request/builder.rs:734-745).
    noOwnOutputNotes: request.expectedOutputOwnNotes().length === 0,
    ...(predicted === undefined
      ? {}
      : {
          predictedHasNoAttachment: predicted.attachments().length === 0,
          // No accessor reads a request's declared recipients; the recipient's random serial number is in the
          // serialized request only if it was declared.
          recipientDeclared: includesBytes(request.serialize(), predicted.recipient().serialNum().serialize())
        }),
    ...(commitment === undefined
      ? {}
      : {
          scriptArgCarried: request.scriptArg()?.toHex() === scriptArgHex,
          adviceCarried: (request.adviceMap().get(commitment) ?? []).map(felt => felt.asInt()).join() === values.join()
        })
  };
  return { request, predicted, scriptRootHex: script.root().toHex(), scriptArgHex, checks };
}
