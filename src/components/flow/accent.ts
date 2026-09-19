import type { ITransactionType } from 'lib/miden/db/types';

/**
 * Highlight color of a flow. Each home action keeps its icon color as the accent of
 * its own flow (tokens in src/main.css); `brand` is the orange for everything else.
 * Primary CTAs stay brand orange in every flow.
 */
export type FlowAccent = 'brand' | 'send' | 'receive' | 'earn' | 'swap';

interface AccentClasses {
  text: string;
  border: string;
  tint: string;
}

// Literal class strings, so Tailwind generates every one of them.
export const ACCENT_CLASSES: Record<FlowAccent, AccentClasses> = {
  brand: {
    text: 'text-primary-500',
    border: 'border-primary-500',
    tint: 'bg-primary-50'
  },
  send: {
    text: 'text-accent-send',
    border: 'border-accent-send',
    tint: 'bg-accent-send-tint'
  },
  receive: {
    text: 'text-accent-receive',
    border: 'border-accent-receive',
    tint: 'bg-accent-receive-tint'
  },
  earn: {
    text: 'text-accent-earn',
    border: 'border-accent-earn',
    tint: 'bg-accent-earn-tint'
  },
  swap: {
    text: 'text-accent-swap',
    border: 'border-accent-swap',
    tint: 'bg-accent-swap-tint'
  }
};

/** The flow a transaction belongs to, for the screens every flow shares (Processing, the receipt). */
export function accentForTransactionType(type: ITransactionType | undefined): FlowAccent {
  switch (type) {
    case 'send':
    case 'bridged-send':
      return 'send';
    case 'consume':
    case 'bridged-receive':
      return 'receive';
    case 'earn-deposit':
    case 'earn-withdraw':
      return 'earn';
    case 'swap':
      return 'swap';
    default:
      return 'brand';
  }
}
