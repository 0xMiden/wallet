export type StoryRole = 'you' | 'recipient' | 'network' | 'sender';

export interface StoryParty {
  role: StoryRole;
  name: string;
}

/** Fungible value carried by one note, before it is formatted with the faucet's decimals. */
export interface StoryAsset {
  faucetId: string;
  amount: bigint;
}

/** One transfer: a party sends an amount to another party, sometimes by a note. */
export interface StoryHop {
  from: StoryParty;
  to: StoryParty;
  /** Already-formatted amount. Empty when `assets` still needs the faucet's decimals. */
  amount: string;
  /** How it moves, such as "private". A raw preview label is left as written. */
  via?: string;
  /** Note kind, such as MINT, BURN, P2ID, or fee. Shown on the chip. */
  kind?: string;
  assets?: StoryAsset[];
}

/** Add amounts that share a faucet, so two notes of the same asset become one total. */
export function sumAssets(assets: StoryAsset[]): StoryAsset[] {
  const totals = new Map<string, bigint>();
  for (const asset of assets) {
    totals.set(asset.faucetId, (totals.get(asset.faucetId) ?? 0n) + asset.amount);
  }
  return [...totals].map(([faucetId, amount]) => ({ faucetId, amount }));
}

const you: StoryParty = { role: 'you', name: '' };
const network: StoryParty = { role: 'network', name: '' };

function party(role: StoryRole, name = ''): StoryParty {
  return { role, name };
}

interface Collected {
  sends: string[];
  receives: string[];
  recipient?: string;
  from?: string;
  noteType?: string;
  fee?: string;
  consumed?: number;
  created?: number;
}

function collect(messages: string[]): Collected {
  const found: Collected = { sends: [], receives: [] };
  for (const message of messages) {
    const notes = message.match(/(\d+)\s*consumed\s*\/\s*(\d+)\s*created/i);
    if (notes) {
      found.consumed = Number(notes[1]);
      found.created = Number(notes[2]);
      continue;
    }
    const splitAt = message.indexOf(', ');
    if (splitAt === -1) continue;
    const label = message.slice(0, splitAt).trim().toLowerCase();
    const value = message.slice(splitAt + 2).trim();
    if (!value) continue;
    if (label === 'recipient' || label === 'to') found.recipient = value;
    else if (label === 'from') found.from = value;
    else if (label === 'note type') found.noteType = value;
    else if (label === 'fee' || label.startsWith('network fee')) found.fee = value;
    else if (label.startsWith('receiving') || label.startsWith('you receive') || label === 'incoming') {
      found.receives.push(value);
    } else if (label === 'amount' || label.startsWith('sending') || label.startsWith('you send')) {
      found.sends.push(value);
    }
  }
  return found;
}

/**
 * A send or consume preview, read from the `Label, value` lines the extension
 * window and the mobile sheet share.
 */
export function storyFromMessages(messages: string[], options?: { skip?: number; incoming?: boolean }): StoryHop[] {
  const found = collect(messages.slice(options?.skip ?? 0));
  const incoming = options?.incoming ?? false;
  const hops: StoryHop[] = [];
  const amounts = incoming ? found.receives.concat(found.sends) : found.sends.concat(found.receives);
  const moving = amounts.length > 0 ? amounts : incoming && found.consumed ? [String(found.consumed)] : [];

  if (incoming) {
    for (const amount of moving) {
      hops.push({
        from: party('sender', found.from ?? ''),
        to: you,
        amount,
        via: found.noteType
      });
    }
  } else {
    for (const amount of moving) {
      hops.push({
        from: party('you', found.from ?? ''),
        to: party('recipient', found.recipient ?? ''),
        amount,
        via: found.noteType
      });
    }
    if (moving.length === 0 && found.created) {
      hops.push({
        from: you,
        to: party('recipient', found.recipient ?? ''),
        amount: String(found.created),
        via: found.noteType
      });
    }
  }

  if (found.fee) {
    hops.push({ from: you, to: network, amount: found.fee });
  }
  return hops;
}

/** One hop per consumed note into the account, then one hop per note the account creates. */
export function storyFromNoteFlow(
  flow: {
    inputs: Array<{ sender?: string; visibility: string; kind: string; assets?: StoryAsset[] }>;
    outputs: Array<{ visibility: string; kind: string; assets?: StoryAsset[] }>;
  },
  accountName = ''
): StoryHop[] {
  const self = party('you', accountName);
  const hops: StoryHop[] = [];
  for (const note of flow.inputs) {
    hops.push({
      from: party('sender', note.sender ?? ''),
      to: self,
      amount: '',
      via: note.visibility,
      kind: note.kind,
      assets: note.assets
    });
  }
  for (const note of flow.outputs) {
    const fee = note.kind === 'fee' || note.kind === 'TX_FEE';
    hops.push({
      from: self,
      to: fee ? network : party('recipient'),
      amount: '',
      via: note.visibility,
      kind: note.kind,
      assets: note.assets
    });
  }
  return hops;
}
