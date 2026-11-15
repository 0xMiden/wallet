import React, { createContext, useCallback, useContext, useReducer, useRef } from 'react';

import type { AccountScope } from 'lib/miden-chain/account-scope';
import type { SendDraft } from 'screens/send-flow/send-draft';

import type { CommandAction } from './command-routes';

export type CommandSendRecall = { kind: 'never' } | { kind: 'scheduled'; date?: string; time: string; blocks?: string };

export interface CommandDrafts {
  send: SendDraft & { privacy?: 'public' | 'private'; recall?: CommandSendRecall };
  receive: { faucetId: string };
  swap:
    | {
        engine: 'swap';
        payTokenId: string;
        receiveTokenId: string;
        payAmount: string;
        expirySeconds: string;
        slippageBps: number;
        autoAccept: boolean;
      }
    | {
        engine: 'one-click';
        payNetworkId: string;
        receiveNetworkId: string;
        payAssetId: string;
        receiveAssetId: string;
        payAmount: string;
        externalAddress: string;
      };
  earn: { mode: 'deposit' | 'withdraw'; subjectId: string; amount: string };
  bridge: { direction: 'in' | 'out'; route: string; amount: string; externalAccountId: string };
}

interface DraftContext {
  readDraft: <K extends CommandAction>(action: K) => CommandDrafts[K] | undefined;
  writeDraft: <K extends CommandAction>(action: K, draft: CommandDrafts[K]) => void;
  clearDraft: (action: CommandAction) => void;
  clearDrafts: () => void;
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
  const current = useRef<{ key: string; generation: number; drafts: Partial<CommandDrafts> }>({
    key: scopeKey,
    generation: 0,
    drafts: {}
  });
  const [, refresh] = useReducer(value => value + 1, 0);
  if (current.current.key !== scopeKey)
    current.current = { key: scopeKey, generation: current.current.generation + 1, drafts: {} };
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

  return <Context.Provider value={{ readDraft, writeDraft, clearDraft, clearDrafts }}>{children}</Context.Provider>;
}

export function useOptionalCommandDrafts(): DraftContext | null {
  return useContext(Context);
}

export function useCommandDrafts(): DraftContext {
  const context = useOptionalCommandDrafts();
  if (!context) throw new Error('Command drafts require a Command shell');
  return context;
}
