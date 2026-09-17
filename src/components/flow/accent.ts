import type { ITransactionType } from 'lib/miden/db/types';

/**
 * Highlight color of a flow. Each home action keeps its icon color as the accent of
 * its own flow (tokens in src/main.css); `brand` is the orange for everything else.
 * Primary CTAs stay brand orange in every flow.
 */
export type FlowAccent = 'brand' | 'send' | 'receive' | 'earn' | 'swap';

interface AccentClasses {
  text: string;
  bg: string;
  border: string;
  tint: string;
  caret: string;
}

// Literal class strings, so Tailwind generates every one of them.
export const ACCENT_CLASSES: Record<FlowAccent, AccentClasses> = {
  brand: {
    text: 'text-primary-500',
    bg: 'bg-primary-500',
    border: 'border-primary-500',
    tint: 'bg-primary-50',
    caret: 'caret-primary-500'
  },
  send: {
    text: 'text-accent-send',
    bg: 'bg-accent-send',
    border: 'border-accent-send',
    tint: 'bg-accent-send-tint',
    caret: 'caret-accent-send'
  },
  receive: {
    text: 'text-accent-receive',
    bg: 'bg-accent-receive',
    border: 'border-accent-receive',
    tint: 'bg-accent-receive-tint',
    caret: 'caret-accent-receive'
  },
  earn: {
    text: 'text-accent-earn',
    bg: 'bg-accent-earn',
    border: 'border-accent-earn',
    tint: 'bg-accent-earn-tint',
    caret: 'caret-accent-earn'
  },
  swap: {
    text: 'text-accent-swap',
    bg: 'bg-accent-swap',
    border: 'border-accent-swap',
    tint: 'bg-accent-swap-tint',
    caret: 'caret-accent-swap'
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
