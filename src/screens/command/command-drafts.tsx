import React, { createContext, useCallback, useContext, useReducer, useRef } from 'react';

import type { AccountScope } from 'lib/miden-chain/account-scope';
import type { SendDraft } from 'screens/send-flow/send-draft';

import type { CommandAction } from './command-routes';

export type CommandSendRecall =
  | { kind: 'never' }
  | { kind: 'scheduled'; date?: string; time: string; blocks?: string }
  | { kind: 'calendar'; target: string };

export interface CommandDrafts {
  send: SendDraft & { privacy?: 'public' | 'private'; recall?: CommandSendRecall; reviewId?: string };
  receive: { faucetId: string };
  swap: {
    engine: 'swap';
    payTokenId: string;
    receiveTokenId: string;
    payAmount: string;
    expirySeconds: string;
    slippageBps: number;
    autoAccept: boolean;
  };
  earn: { mode: 'deposit' | 'withdraw'; subjectId: string; amount: string };
  bridge: { direction: 'in' | 'out'; route: string; amount: string; externalAccountId: string };
}

interface SendAdmission {
  intent: string;
  revision: number;
  status: 'pending' | 'admitted';
  txId?: string;
}

interface DraftContext {
  readDraft: <K extends CommandAction>(action: K) => CommandDrafts[K] | undefined;
  writeDraft: <K extends CommandAction>(action: K, draft: CommandDrafts[K]) => void;
  clearDraft: (action: CommandAction) => void;
  clearDrafts: () => void;
  readSendAdmission: () => SendAdmission | undefined;
  readSendDraftRevision: () => number;
  beginSendAdmission: (intent: string) => boolean;
  finishSendAdmission: (intent: string, txId: string) => void;
  abortSendAdmission: (intent: string) => void;
}

const Context = createContext<DraftContext | null>(null);

export function CommandDraftProvider({
  scope,
  children
}: {
  scope: AccountScope;
  children: React.ReactNode;
}): React.ReactElement {
  const scopeKey = JSON.stringify([scope.accountId, scope.network, scope.rpcUrl]);
  const current = useRef<{
    key: string;
    generation: number;
    drafts: Partial<CommandDrafts>;
    sendDraftRevision: number;
    sendAdmission?: SendAdmission;
  }>({ key: scopeKey, generation: 0, drafts: {}, sendDraftRevision: 0 });
  const [, refresh] = useReducer(value => value + 1, 0);
  if (current.current.key !== scopeKey)
    current.current = { key: scopeKey, generation: current.current.generation + 1, drafts: {}, sendDraftRevision: 0 };
  const generation = current.current.generation;

  const readDraft = useCallback(
    <K extends CommandAction>(action: K): CommandDrafts[K] | undefined => {
      if (current.current.generation !== generation) return undefined;
      return current.current.drafts[action];
    },
    [generation]
  );
  const writeDraft = useCallback(
    <K extends CommandAction>(action: K, draft: CommandDrafts[K]): void => {
      if (current.current.generation !== generation) return;
      if (action === 'send') {
        if (!current.current.drafts.send) current.current.sendDraftRevision++;
        if (current.current.sendAdmission?.status === 'admitted') current.current.sendAdmission = undefined;
      }
      current.current.drafts[action] = draft;
      refresh();
    },
    [generation]
  );
  const clearDraft = useCallback(
    (action: CommandAction) => {
      if (current.current.generation !== generation) return;
      delete current.current.drafts[action];
      refresh();
    },
    [generation]
  );
  const clearDrafts = useCallback(() => {
    if (current.current.generation !== generation) return;
    current.current.drafts = {};
    refresh();
  }, [generation]);
  const readSendAdmission = useCallback(
    () => (current.current.generation === generation ? current.current.sendAdmission : undefined),
    [generation]
  );
  const readSendDraftRevision = useCallback(
    () => (current.current.generation === generation ? current.current.sendDraftRevision : -1),
    [generation]
  );
  const beginSendAdmission = useCallback(
    (intent: string) => {
      if (
        current.current.generation !== generation ||
        current.current.sendAdmission?.status === 'pending' ||
        current.current.sendAdmission?.intent === intent
      )
        return false;
      current.current.sendAdmission = { intent, revision: current.current.sendDraftRevision, status: 'pending' };
      refresh();
      return true;
    },
    [generation]
  );
  const finishSendAdmission = useCallback(
    (intent: string, txId: string) => {
      const admission = current.current.sendAdmission;
      if (current.current.generation !== generation || admission?.status !== 'pending' || admission.intent !== intent)
        return;
      const draft = current.current.drafts.send;
      if (admission.revision !== current.current.sendDraftRevision) {
        current.current.sendAdmission = undefined;
      } else {
        current.current.sendAdmission = { ...admission, status: 'admitted', txId };
        if (
          draft &&
          JSON.stringify([
            draft.reviewId ?? null,
            draft.amount,
            draft.recipientAddress,
            draft.tokenId,
            draft.bridgeNetwork,
            draft.bridgeRoute
          ]) === intent
        )
          delete current.current.drafts.send;
      }
      refresh();
    },
    [generation]
  );
  const abortSendAdmission = useCallback(
    (intent: string) => {
      if (
        current.current.generation !== generation ||
        current.current.sendAdmission?.status !== 'pending' ||
        current.current.sendAdmission.intent !== intent
      )
        return;
      current.current.sendAdmission = undefined;
      refresh();
    },
    [generation]
  );

  return (
    <Context.Provider
      value={{
        readDraft,
        writeDraft,
        clearDraft,
        clearDrafts,
        readSendAdmission,
        readSendDraftRevision,
        beginSendAdmission,
        finishSendAdmission,
        abortSendAdmission
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useOptionalCommandDrafts(): DraftContext | null {
  return useContext(Context);
}

export function useCommandDrafts(): DraftContext {
  const context = useOptionalCommandDrafts();
  if (!context) throw new Error('Command drafts require a Command shell');
  return context;
}
