import React, { useState } from 'react';

import { MotionConfig } from 'framer-motion';
import { createRoot } from 'react-dom/client';

import '../../../src/i18n';
import '../../../src/main.css';
import AwaitFonts from '../../../src/app/a11y/AwaitFonts';
import FullScreenPage from '../../../src/app/layouts/FullScreenPage';
import { TransactionSuccess } from '../../../src/screens/generating-transaction/TransactionSuccess';
import { IETH, USDCX } from './fixture';
import { AmountIdea, AmountVariant } from './amount';
import { AmountBold } from './amount-bold';
import { AmountOnSystem } from './amount-ds';
import { SAMPLE_ETH_ADDRESS, SendFlowPrototype } from './flow';
import { SendAmount } from '../../../src/screens/send-flow/SendAmount';
import { USDCX as AMOUNT_TOKEN } from './fixture';
import { IdeaVariant, SendIdea, SwapIdea, SwapVariant } from './ideas';
import { StrongVariant, SwapStrong } from './strong';
import { CurrentSendFlow } from './current';
import type { ArrivalStyle } from './arrival';
import { comparePage, dappDocument, SINGLE_MODE } from './single-mode';
import { StatusBar, SuccessV2 } from './mock-flow-v2';
import { RecipientIdea, RecipientVariant } from './recipient-ideas';
import { ReviewBold, ReviewVariant } from './review-bold';
import { ReviewStrong, ReviewTone } from './review-strong';
import { SendInStyle, SendStyle } from './styles';
import { SwapTicket } from './ticket';
import { MicroTab } from './micro';

const RECIPIENT = 'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x';
const base = { id: 'fixture-tx', accountId: 'fixture-miden-account', feeAmount: 10000n, feeFaucetId: USDCX };
const SCREENS = [
  { id: 'send', label: 'Send', tx: { ...base, type: 'send', amount: 25000000n, faucetId: USDCX, secondaryAccountId: RECIPIENT } },
  {
    id: 'claim',
    label: 'Claim',
    tx: { ...base, type: 'consume', amount: 25000000n, faucetId: USDCX, secondaryAccountId: RECIPIENT, noteId: '0x7be1c0d24a9f' }
  },
  {
    id: 'swap',
    label: 'Swap',
    tx: {
      ...base,
      type: 'swap',
      amount: 25000000n,
      faucetId: USDCX,
      extraInputs: { requestedAmount: 7100000000000000n, requestedFaucetId: IETH }
    }
  },
  {
    id: 'earn',
    label: 'Earn deposit',
    tx: {
      ...base,
      type: 'earn-deposit',
      amount: 25000000n,
      faucetId: USDCX,
      extraInputs: { marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69' }
    }
  },
  {
    id: 'bridge',
    label: 'Bridge',
    tx: {
      ...base,
      type: 'send',
      amount: 25000000n,
      faucetId: USDCX,
      secondaryAccountId: RECIPIENT,
      extraInputs: { destinationAddress: '0x52908400098527886E0F7030069857D2E4169EE7', destinationNetwork: 1, provider: 'epoch' }
    }
  },
  {
    id: 'guardian',
    label: 'Guardian switch',
    tx: {
      ...base,
      type: 'switch-guardian',
      extraInputs: {
        previousGuardianEndpoint: 'https://guardian.miden.io',
        newGuardianEndpoint: 'https://guardian.openzeppelin.com'
      }
    }
  }
];

// The popup's size: CONFIRM_WINDOW_WIDTH and CONFIRM_WINDOW_HEIGHT in src/lib/miden/back/dapp.ts.
const WINDOW_W = 440;
const WINDOW_H = 760;
const DAPP_SCREENS = [
  { id: 'connect', label: 'Connect' },
  { id: 'connect-auto', label: 'Connect, with standing private-data access' },
  { id: 'send', label: 'Transaction: send' },
  { id: 'consume', label: 'Transaction: consume a note' },
  { id: 'sign', label: 'Signature: message' },
  { id: 'privateNotes', label: 'Request private notes' },
  { id: 'assets', label: 'Request assets' }
];

const tabStyle = (active: boolean): React.CSSProperties => ({
  border: 0,
  background: active ? '#3f3f3f' : '#f3f0ec',
  color: active ? '#fff' : '#3f3f3f',
  font: "700 14px 'Nunito'",
  padding: '10px 18px',
  borderRadius: 999,
  cursor: 'pointer'
});

function SuccessScreens({ v2 = false }: { v2?: boolean }) {
  const [replay, setReplay] = useState(0);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          {v2
            ? 'Speculative: every receipt in the "Option 3, thicker" style. Rows stacked on the left edge, outlined card, labels semibold, values extrabold.'
            : 'Real components from the working tree, as they are today.'}
        </span>
        <button onClick={() => setReplay(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Replay all
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {SCREENS.map(screen => (
          <div key={screen.id}>
            <div style={{ font: "800 14px 'Nunito'", marginBottom: 8 }}>{screen.label}</div>
            <div
              key={replay}
              data-screen={screen.id}
              data-v2={v2 ? '' : undefined}
              style={{
                width: 393,
                height: 852,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderRadius: 32,
                border: '1px solid rgba(63,63,63,.15)',
                transform: 'translateZ(0)',
                background: '#fff'
              }}
            >
              {/* The app mounts this page in FullScreenPage with a fade (PageRouter, /generating-transaction/:txId). */}
              <FullScreenPage entrance="fade">
                <TransactionSuccess
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  transaction={screen.tx as any}
                  txHash="0x91c4a7d2be5f3308c61e07a4"
                  onDoneClick={() => undefined}
                  onViewExplorer={() => undefined}
                />
              </FullScreenPage>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function DappWork() {
  return (
    <>
      <div style={{ font: "400 14px 'Nunito'", color: '#6b6b6b', marginBottom: 20 }}>
        The real confirm window from main (src/app/ConfirmPage.tsx), one per request type, at the popup's own size.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {DAPP_SCREENS.map(screen => (
          <div key={screen.id}>
            <div style={{ font: "800 14px 'Nunito'", marginBottom: 8 }}>{screen.label}</div>
            <iframe
              // In the single file there is no second page to load: the frame is given a whole document.
              {...(SINGLE_MODE ? { srcDoc: dappDocument(screen.id) } : { src: `dapp.html?id=${screen.id}` })}
              title={screen.label}
              style={{ width: WINDOW_W, height: WINDOW_H, border: '1px solid rgba(63,63,63,.15)', borderRadius: 16, background: '#fff' }}
            />
          </div>
        ))}
      </div>
    </>
  );
}

const IDEAS: { id: IdeaVariant; label: string; note: string }[] = [
  { id: 'today', label: 'Today', note: 'As it is now, after removing the story strip.' },
  { id: 'a', label: 'A. Room to breathe', note: 'Only spacing: 16px between the title and the pill.' },
  { id: 'b', label: 'B. Amount first', note: 'The amount is the headline figure, recipient beneath; the pill goes.' },
  { id: 'c', label: 'C. Receipt at the bottom', note: 'Receipt sits on the buttons; the result gets the open space.' }
];

function Ideas() {
  const [replay, setReplay] = useState(0);
  const send = SCREENS[0]!;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          Send success, rearranged. Same components, text, rows and buttons throughout.
        </span>
        <button onClick={() => setReplay(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Replay all
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {IDEAS.map(idea => (
          <div key={idea.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{idea.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px', minHeight: 36 }}>{idea.note}</div>
            <div
              key={replay}
              data-idea={idea.id}
              style={{
                width: 393,
                height: 852,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderRadius: 32,
                border: '1px solid rgba(63,63,63,.15)',
                transform: 'translateZ(0)',
                background: '#fff'
              }}
            >
              <FullScreenPage entrance="fade">
                <SendIdea
                  variant={idea.id}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  transaction={send.tx as any}
                  txHash="0x91c4a7d2be5f3308c61e07a4"
                  onDoneClick={() => undefined}
                  onViewExplorer={() => undefined}
                />
              </FullScreenPage>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const IDEAS2: { id: IdeaVariant; label: string; note: string }[] = [
  { id: 'today', label: 'Today', note: 'The address row is stacked and left-aligned; the other three are right-aligned.' },
  { id: 'r1', label: '1. All right, short address', note: 'Every value right-aligned. The address is shortened to fit one line.' },
  { id: 'r2', label: '2. All right, full address', note: 'Every value right-aligned. The full address wraps onto two lines.' },
  { id: 'r3', label: '3. All left', note: 'Every row stacked: label above, value below, all on the left edge.' },
  { id: 'r4', label: '4. Address out of the card', note: 'Full address sits under the pill; the card keeps three matching rows.' },
  { id: 'l1', label: '5. Amount first', note: 'Big amount, full address beneath it, three matching rows. No pill.' },
  { id: 'l2', label: '6. Option 1 with room to breathe', note: 'Option 1, plus 16px between the title and the pill.' }
];

function Ideas2() {
  const [replay, setReplay] = useState(0);
  const send = SCREENS[0]!;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          Send success: the receipt rows made consistent four ways, then two fuller layouts. Same data and buttons throughout.
        </span>
        <button onClick={() => setReplay(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Replay all
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {IDEAS2.map(idea => (
          <div key={idea.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{idea.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px', minHeight: 36 }}>{idea.note}</div>
            <div
              key={replay}
              data-idea={idea.id}
              style={{
                width: 393,
                height: 852,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderRadius: 32,
                border: '1px solid rgba(63,63,63,.15)',
                transform: 'translateZ(0)',
                background: '#fff'
              }}
            >
              <FullScreenPage entrance="fade">
                <SendIdea
                  variant={idea.id}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  transaction={send.tx as any}
                  txHash="0x91c4a7d2be5f3308c61e07a4"
                  onDoneClick={() => undefined}
                  onViewExplorer={() => undefined}
                />
              </FullScreenPage>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const IDEAS3: { id: IdeaVariant; label: string; note: string }[] = [
  { id: 'r3', label: 'Option 3, as before', note: 'Every row stacked, label above value, on the left edge.' },
  { id: 'r3b', label: 'Option 3, thicker', note: 'Same rows: labels semibold, values extrabold.' },
  { id: 'p1', label: 'Phantom A: address as headline', note: 'After Phantom\'s detail sheet: left edge, full address large, plain rows, no card or pill.' },
  { id: 'p2', label: 'Phantom B: giant amount', note: 'After Phantom\'s review screen: left edge, very large amount, label-over-value rows, no card or pill.' }
];

function Ideas3() {
  const [replay, setReplay] = useState(0);
  const send = SCREENS[0]!;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          Send success: option 3 with heavier type, and two takes on how Phantom lays out a transaction. Same data and buttons throughout.
        </span>
        <button onClick={() => setReplay(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Replay all
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {IDEAS3.map(idea => (
          <div key={idea.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{idea.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px', minHeight: 36 }}>{idea.note}</div>
            <div
              key={replay}
              data-idea={idea.id}
              style={{
                width: 393,
                height: 852,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderRadius: 32,
                border: '1px solid rgba(63,63,63,.15)',
                transform: 'translateZ(0)',
                background: '#fff'
              }}
            >
              <FullScreenPage entrance="fade">
                <SendIdea
                  variant={idea.id}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  transaction={send.tx as any}
                  txHash="0x91c4a7d2be5f3308c61e07a4"
                  onDoneClick={() => undefined}
                  onViewExplorer={() => undefined}
                />
              </FullScreenPage>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const IDEAS4: { id: IdeaVariant; label: string; note: string }[] = [
  { id: 'p1', label: 'Phantom A, as before', note: '"Payment Sent!", full address large, wrapping where it overflows.' },
  { id: 'pa1', label: 'A1. Short address', note: '"You sent!" The address shortened in the middle, large, on one line.' },
  { id: 'pa2', label: 'A2. Full address, row size', note: '"You sent!" The full address on one line at the same size as the row values.' },
  { id: 'pa3', label: 'A3. Amount in the headline', note: '"You sent 25 USDCX". Full address on one line at row size.' },
  { id: 'pa4', label: 'A4. Two even lines', note: '"You sent!" The full address large, split into two equal lines.' }
];

function Ideas4() {
  const [replay, setReplay] = useState(0);
  const send = SCREENS[0]!;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          Phantom A, iterated: a personal headline and four ways to set the address.
        </span>
        <button onClick={() => setReplay(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Replay all
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {IDEAS4.map(idea => (
          <div key={idea.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{idea.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px', minHeight: 36 }}>{idea.note}</div>
            <div
              key={replay}
              data-idea={idea.id}
              style={{
                width: 393,
                height: 852,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderRadius: 32,
                border: '1px solid rgba(63,63,63,.15)',
                transform: 'translateZ(0)',
                background: '#fff'
              }}
            >
              <FullScreenPage entrance="fade">
                <SendIdea
                  variant={idea.id}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  transaction={send.tx as any}
                  txHash="0x91c4a7d2be5f3308c61e07a4"
                  onDoneClick={() => undefined}
                  onViewExplorer={() => undefined}
                />
              </FullScreenPage>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const SWAP_IDEAS: { id: SwapVariant; label: string; note: string }[] = [
  { id: 'today', label: 'Today', note: 'Both token names are cut short in the pill; one message sits by the card and one by the buttons.' },
  { id: 's1', label: '1. Two-line pill', note: 'Each side of the swap gets its own line in the pill, so both names show in full.' },
  { id: 's2', label: '2. Sides in the card', note: 'No pill: You Pay and You Receive become rows with the fee. Both messages in one line of text below.' },
  { id: 's3', label: '3. Smaller pill, messages together', note: 'Pill stays one line at a smaller size. Both messages share one box under the card.' }
];

function SwapIdeas() {
  const [replay, setReplay] = useState(0);
  const swap = SCREENS.find(screen => screen.id === 'swap')!;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          Swap success, three ways to fix the cut-off pill and the scattered messages. Same text, data and buttons.
        </span>
        <button onClick={() => setReplay(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Replay all
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {SWAP_IDEAS.map(idea => (
          <div key={idea.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{idea.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px', minHeight: 36 }}>{idea.note}</div>
            <div
              key={replay}
              data-idea={idea.id}
              style={{
                width: 393,
                height: 852,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderRadius: 32,
                border: '1px solid rgba(63,63,63,.15)',
                transform: 'translateZ(0)',
                background: '#fff'
              }}
            >
              <FullScreenPage entrance="fade">
                <SwapIdea
                  variant={idea.id}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  transaction={swap.tx as any}
                  onDoneClick={() => undefined}
                />
              </FullScreenPage>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const STRONG: { id: StrongVariant; label: string; note: string }[] = [
  { id: 'ticket', label: '1. Trade ticket', note: 'Pay and receive as two joined tiles, each amount large and in full. After Base and World App.' },
  { id: 'timeline', label: '2. Order timeline', note: 'Created, sourcing, filled: the three steps in order, with where you are now. After Public and MoonPay.' },
  { id: 'receive', label: '3. What you get', note: 'One huge figure: the amount on its way to you. Everything else is a quiet row. After Crypto.com.' },
  { id: 'ring', label: '4. Still turning', note: 'A turning ring replaces the finished check, over the receipt card you chose. After Aave.' },
  { id: 'band', label: '5. Colour block', note: 'The whole order as one solid block in the swap colour, with a runner while it fills.' }
];

function StrongSwap() {
  const [replay, setReplay] = useState(0);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          Swap success, redesigned from what the moment is: an order that is created but still filling.
        </span>
        <button onClick={() => setReplay(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Replay all
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {STRONG.map(idea => (
          <div key={idea.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{idea.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px', minHeight: 36 }}>{idea.note}</div>
            <div
              key={replay}
              data-strong={idea.id}
              style={{
                width: 393,
                height: 852,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderRadius: 32,
                border: '1px solid rgba(63,63,63,.15)',
                transform: 'translateZ(0)',
                background: '#fff'
              }}
            >
              <FullScreenPage entrance="fade">
                <SwapStrong variant={idea.id} />
              </FullScreenPage>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function TicketOnly() {
  const [replay, setReplay] = useState(0);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          One design, worked through: the trade as a ticket, with the app's real token logos and icons.
        </span>
        <button onClick={() => setReplay(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Replay
        </button>
      </div>
      <div
        key={replay}
        style={{
          width: 393,
          height: 852,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 32,
          border: '1px solid rgba(63,63,63,.15)',
          transform: 'translateZ(0)',
          background: '#fff'
        }}
      >
        <FullScreenPage entrance="fade">
          <SwapTicket />
        </FullScreenPage>
      </div>
    </>
  );
}

const STYLES: { id: SendStyle; label: string; note: string }[] = [
  { id: 'yours', label: 'Your mock', note: 'Built as you drew it, with the real header, check, token logo and buttons.' },
  { id: 'centered', label: 'Your mock, centered', note: 'Your second mock: the check, headline and address centred; rows unchanged.' },
  { id: 'stacked', label: 'Your mock, amount on its own line', note: 'Your third mock: "You sent" small, the amount large with the logo after it, a smaller address line.' },
  { id: 'sharp', label: 'Your third mock, sharpened', note: 'Top half only: sizes and gaps on one scale, a logo that matches the amount, a readable address.' },
  { id: 'guide', label: 'From your Background.svg', note: 'Built to its measurements: full-width address pill beside "to:", rows with no dividers.' },
  { id: 'm1', label: 'Your mock, tightened', note: 'One type size in the headline, a tappable copy chip, no repeated Total Paid row.' },
  { id: 'm2', label: 'Your mock, amount leads', note: 'Tightened, plus the amount as the big figure on its own line.' },
  { id: 'm3', label: 'Your mock, using the height', note: 'Amount leads, plus the rows anchored above the buttons.' },
  { id: 'wise', label: 'After Wise', note: 'One colour, one huge check, a few words.' },
  { id: 'cashapp', label: 'After Cash App', note: 'A check and one sentence. The receipt is a button.' },
  { id: 'kraken', label: 'After Kraken', note: 'Recipient on top, the sentence, plain rows with no card.' },
  { id: 'coinbase', label: 'After Coinbase Wallet', note: 'Dark, centred, the amount in the brand colour.' },
  { id: 'monzo', label: 'After Monzo', note: 'Soft tinted page, the Bread mark as the picture, one sentence.' },
  { id: 'gojek', label: 'After Gojek', note: 'The whole screen in Bread orange, both parties, the amount.' },
  { id: 'worldapp', label: 'After World App', note: 'Big check, one card with the two sides of the transfer.' },
  { id: 'wealthsimple', label: 'After Wealthsimple', note: 'Words top left, one large object: the token as coins.' },
  { id: 'chime', label: 'After Chime', note: 'Outline check, one card with the amount large inside it.' }
];

function SendStyles() {
  const [replay, setReplay] = useState(0);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          Bread's Send success in the manner of nine shipped apps. Bread's font, colours, buttons, token logo and mark; their arrangement.
        </span>
        <button onClick={() => setReplay(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Replay all
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {STYLES.map(item => (
          <div key={item.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{item.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px', minHeight: 20 }}>{item.note}</div>
            <div
              key={replay}
              style={{
                width: 393,
                height: 852,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderRadius: 32,
                border: '1px solid rgba(63,63,63,.15)',
                transform: 'translateZ(0)',
                background: '#fff'
              }}
            >
              <SendInStyle style={item.id} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

type ScreenStart = { step: 'recipient' | 'amount' | 'route' | 'review' | 'processing' | 'success'; recipient?: boolean; amount?: string; to?: string };
const ALL_SCREENS: { label: string; start: ScreenStart }[] = [
  { label: '1. Recipient', start: { step: 'recipient' } },
  { label: '2. Recipient chosen', start: { step: 'recipient', recipient: true } },
  { label: '3. Amount', start: { step: 'amount', recipient: true } },
  { label: '4. Amount entered', start: { step: 'amount', recipient: true, amount: '70.25' } },
  { label: '5. Review', start: { step: 'review', recipient: true, amount: '70.25' } },
  { label: '6. Processing', start: { step: 'processing', recipient: true, amount: '70.25' } },
  { label: '7. Success', start: { step: 'success', recipient: true, amount: '70.25' } }
];

// The same send to a 0x address: the recipient step names the network, and a route step sits before the review.
const CROSS_CHAIN_SCREENS: { label: string; start: ScreenStart }[] = [
  { label: '1. Recipient', start: { step: 'recipient', to: SAMPLE_ETH_ADDRESS } },
  { label: '2. Amount', start: { step: 'amount', to: SAMPLE_ETH_ADDRESS } },
  { label: '3. Amount entered', start: { step: 'amount', to: SAMPLE_ETH_ADDRESS, amount: '70.25' } },
  { label: '4. Route', start: { step: 'route', to: SAMPLE_ETH_ADDRESS, amount: '70.25' } },
  { label: '5. Review', start: { step: 'review', to: SAMPLE_ETH_ADDRESS, amount: '70.25' } },
  { label: '6. Processing', start: { step: 'processing', to: SAMPLE_ETH_ADDRESS, amount: '70.25' } },
  { label: '7. Success', start: { step: 'success', to: SAMPLE_ETH_ADDRESS, amount: '70.25' } }
];

function ScreenRow({ variant, crossChain }: { variant?: 'mock' | 'mock2'; crossChain?: boolean }) {
  const screens = crossChain ? CROSS_CHAIN_SCREENS : variant ? ALL_SCREENS.filter(screen => !screen.label.includes('chosen')) : ALL_SCREENS;
  return (
    <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {screens.map(screen => (
        <div key={screen.label}>
          <div style={{ font: "800 15px 'Nunito'", color: '#3f3f3f', marginBottom: 8 }}>{screen.label.replace(/^\d+\. /, '')}</div>
          <div style={PHONE}>
            <SendFlowPrototype start={screen.start} hold variant={variant} />
          </div>
        </div>
      ))}
    </div>
  );
}

const PHONE = {
  width: 393,
  height: 852,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderRadius: 32,
  border: '1px solid rgba(63,63,63,.15)',
  transform: 'translateZ(0)',
  background: '#fff'
} as const;

function AllScreensTab() {
  return <ScreenRow />;
}

function MockFlowTab({ variant = 'mock' }: { variant?: 'mock' | 'mock2' }) {
  const [run, setRun] = useState(0);
  return (
    <div>
      <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 48 }}>
        <div key={run} style={PHONE}>
          <SendFlowPrototype variant={variant} />
        </div>
        <div style={{ maxWidth: 420, font: "400 15px/1.5 'Nunito'", color: '#3f3f3f' }}>
          <div style={{ font: "800 22px 'Nunito'", marginBottom: 8 }}>{variant === 'mock2' ? 'Send, 24 Nov version 2' : 'Send, from your 24 Nov mock'}</div>
          <p style={{ margin: '0 0 12px', color: '#6b6b6b' }}>Click through it like the app. Every screen is also laid out below.</p>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li>
              Tap a recent recipient, press Paste, or type an address and press Continue. One to type:{' '}
              <code style={{ userSelect: 'all', background: '#f1eeea', padding: '2px 6px', borderRadius: 6, fontSize: 13, wordBreak: 'break-all' }}>mtst1aqd8xk3v9p2hn7c5t0wz4ys6ej8ruf2lgm0k</code>
              {' '}or, for Ethereum:{' '}
              <code style={{ userSelect: 'all', background: '#f1eeea', padding: '2px 6px', borderRadius: 6, fontSize: 13, wordBreak: 'break-all' }}>0x71C7656EC7ab88b098defB751B7401B5f6d8976F</code>
            </li>
            <li>Type an amount. Tap the token pill to change token.</li>
            <li>On review, tap Transfer type or Expires to change them, then slide to send.</li>
            <li>Processing runs its steps, then the success screen arrives.</li>
          </ol>
          <button onClick={() => setRun(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff', marginTop: 20 }}>
            Start over
          </button>
        </div>
      </div>
      {variant === 'mock2' && <div style={{ font: "800 22px 'Nunito'", color: '#3f3f3f', marginBottom: 16 }}>To a Miden address</div>}
      <ScreenRow variant={variant} />
      {variant === 'mock2' && (
        <>
          <div style={{ font: "800 22px 'Nunito'", color: '#3f3f3f', margin: '56px 0 16px' }}>To another chain (an Ethereum address)</div>
          <ScreenRow variant={variant} crossChain />
        </>
      )}
    </div>
  );
}

const RECIPIENT_IDEAS: { id: RecipientVariant; label: string; note: string }[] = [
  { id: 'cards', label: '1. Two cards', note: 'Who, then where: two labelled outlined cards, matching the recent-recipient cards. Arrangement after Neo Financial.' },
  { id: 'centred', label: '2. The person is the screen', note: 'Big avatar and name, as the amount is on the next step; the rest are plain rows like the review. After Google Pay.' },
  { id: 'token', label: '3. Token in the field', note: 'The field stays a field: the recipient is a removable token with the network beside it. After Cash App.' }
];

function RecipientIdeasTab() {
  const [known, setKnown] = useState(true);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>The recipient step once someone is chosen. Same content as the app in each.</span>
        <button onClick={() => setKnown(value => !value)} style={tabStyle(false)}>
          Recipient: {known ? 'saved contact' : 'not in address book'} (switch)
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {RECIPIENT_IDEAS.map(idea => (
          <div key={idea.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{idea.label}</div>
            <div style={{ font: "400 13px/1.4 'Nunito'", color: '#6b6b6b', margin: '2px 0 10px', minHeight: 36 }}>{idea.note}</div>
            <div style={PHONE}>
              <RecipientIdea
                variant={idea.id}
                address={known ? 'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x' : 'mtst1arvdwvzllvg3s5fzjle7nkljeuhkcufr'}
                name={known ? 'Maya' : undefined}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const SHORTCUT_IDEAS: { id: 'chips' | 'slider' | 'inline' | 'keyboard'; label: string; note: string }[] = [
  { id: 'keyboard', label: 'New: on the keyboard', note: 'A bar of four chips riding on top of the keyboard, as Kraken does. The screen above keeps only the amount and Continue.' },
  { id: 'chips', label: '1. Four chips', note: 'Separate outlined chips. The one you tap fills orange, so you can see what made the amount.' },
  { id: 'slider', label: '2. Sliding selection', note: 'One grey track. A white thumb slides to the share you tap, like the phone\'s own segmented control.' },
  { id: 'inline', label: '3. With the balance', note: 'Small chips directly under "available", the number they act on. Nothing sits above Continue.' }
];

function ShortcutIdeasTab() {
  return (
    <>
      <div style={{ font: "400 14px 'Nunito'", color: '#6b6b6b', marginBottom: 20 }}>
        Only the 25 / 50 / 75 / Max shortcuts change. Tap them: each option shows which one is chosen, and typing clears it.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {SHORTCUT_IDEAS.map(idea => (
          <div key={idea.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{idea.label}</div>
            <div style={{ font: "400 13px/1.4 'Nunito'", color: '#6b6b6b', margin: '2px 0 10px', minHeight: 36 }}>{idea.note}</div>
            <div style={PHONE}>
              <AmountBold name="Maya" shortcuts={idea.id} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// The comparison pages against shipped apps ship with the site, in its compare/ folder (copied in after
// each build from Desktop/CLAUDE/bread-send-prototype/compare), and are shown here in a frame.
function ComparisonTab({ file }: { file: string }) {
  const url = `compare/${file}`;
  // In the single file the page comes from inside it, images included.
  const embedded = SINGLE_MODE ? comparePage(file) : undefined;
  return (
    <div>
      <div style={{ font: "400 14px 'Nunito'", color: '#6b6b6b', marginBottom: 12 }}>
        Screens from shipped apps, collected from Mobbin.{' '}
        {!SINGLE_MODE && (
          <a href={url} target="_blank" rel="noreferrer" style={{ color: '#b3501a', fontWeight: 800 }}>
            Open on its own
          </a>
        )}
      </div>
      <iframe
        title={file}
        {...(embedded ? { srcDoc: embedded } : { src: url })}
        style={{ width: '100%', height: 'calc(100vh - 120px)', minHeight: 900, border: '1px solid rgba(63,63,63,.15)', borderRadius: 20, background: '#fff' }}
      />
    </div>
  );
}

const ARRIVALS: { id: ArrivalStyle; label: string; note: string }[] = [
  { id: 'pop', label: '1. Pop', note: 'The coin lands, swells and turns into the tick. One ring goes out.' },
  { id: 'flip', label: '2. Coin flip', note: 'It hops, turns over in the air and lands tick side up.' },
  { id: 'drop', label: '3. Drop and squash (chosen)', note: 'It drops in from above, squashes on landing, and the tick springs up out of it.' },
  { id: 'wipe', label: '4. Wipe', note: 'The calm one: the coin settles, then green spreads over it from the centre.' },
  { id: 'burst', label: '5. Burst', note: 'The pop, with eight small dots thrown outward as it turns.' }
];

function ArrivalTab() {
  const [run, setRun] = useState(0);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          How the tick arrives on the success screen. Each plays once; click a phone to replay it, or replay them all.
        </span>
        <button onClick={() => setRun(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Replay all
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {ARRIVALS.map(item => (
          <ArrivalPhone key={`${item.id}-${run}`} item={item} />
        ))}
      </div>
    </>
  );
}

function ArrivalPhone({ item }: { item: (typeof ARRIVALS)[number] }) {
  const [run, setRun] = useState(0);
  return (
    <div style={{ width: 393 }}>
      <div style={{ font: "800 14px 'Nunito'" }}>{item.label}</div>
      <div style={{ font: "400 13px/1.4 'Nunito'", color: '#6b6b6b', margin: '2px 0 10px', minHeight: 36 }}>{item.note}</div>
      <div style={{ ...PHONE, height: 560, cursor: 'pointer' }} onClick={() => setRun(n => n + 1)} title="Click to replay">
        <StatusBar />
        <div key={run} style={{ height: 798, flex: 'none', display: 'flex', flexDirection: 'column' }}>
          <SuccessV2 amount="70.25" address="mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x" name="Maya" arrival={item.id} onDone={() => undefined} />
        </div>
      </div>
    </div>
  );
}

function FlowTab() {
  const [run, setRun] = useState(0);
  return (
    <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div
        key={run}
        style={{
          width: 393,
          height: 852,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 32,
          border: '1px solid rgba(63,63,63,.15)',
          transform: 'translateZ(0)',
          background: '#fff'
        }}
      >
        <SendFlowPrototype />
      </div>
      <div style={{ maxWidth: 420, font: "400 15px/1.5 'Nunito'", color: '#3f3f3f' }}>
        <div style={{ font: "800 22px 'Nunito'", marginBottom: 8 }}>Send, start to finish</div>
        <p style={{ margin: '0 0 12px', color: '#6b6b6b' }}>Click through it like the app. Nothing here can sign or send. The number keyboard on the amount step is a drawing of the phone's own; its keys work.</p>
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          <li>Tap a recent recipient, or Paste, then Continue.</li>
          <li>Type an amount (balance is 140.5 USDCX), then Continue.</li>
          <li>On Review, drag the thumb to the right to send. Let go early and it springs back.</li>
          <li>Processing runs its five steps, then the success screen arrives.</li>
        </ol>
        <button
          onClick={() => setRun(n => n + 1)}
          style={{ ...tabStyle(false), background: '#e77537', color: '#fff', marginTop: 20 }}
        >
          Start over
        </button>
      </div>
    </div>
  );
}

const AMOUNT_IDEAS: { id: AmountVariant | 'today'; label: string; note: string }[] = [
  { id: 'today', label: 'Today', note: 'The app\'s real amount step. (No price feed in this preview, hence "USD estimate unavailable".)' },
  { id: 'tidy', label: '1. Tidied', note: 'Same shape. Recipient moves to the top, the unit sits beside the number, chips shrink.' },
  { id: 'centered', label: '2. Centred', note: 'The amount is the one big thing in the middle. After Family, Solflare and Cash App.' },
  { id: 'card', label: '3. One card', note: 'Amount and token share a card, joined to who it goes to. After Uniswap.' }
];

function TodayAmount() {
  const [amount, setAmount] = useState('');
  const n = Number(amount);
  return (
    <SendAmount
      token={{ id: AMOUNT_TOKEN, name: 'USDCX', decimals: 6, balance: 140.5, fiatPrice: 1, scaleIsKnown: true }}
      amount={amount}
      isValidAmount={amount !== '' && n > 0 && n <= 140.5}
      recipientAddress="mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x"
      recipientName="Maya"
      network="miden"
      onAmountChange={setAmount}
      onSelectToken={() => undefined}
      onReceive={() => undefined}
      onBack={() => undefined}
      onConfirm={() => undefined}
    />
  );
}

function AmountIdeas() {
  return (
    <>
      <div style={{ font: "400 14px 'Nunito'", color: '#6b6b6b', marginBottom: 20 }}>
        Send's "Enter amount" step, three ways. They are live: type in them and tap the chips.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {AMOUNT_IDEAS.map(idea => (
          <div key={idea.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{idea.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px', minHeight: 36 }}>{idea.note}</div>
            <div
              style={{
                width: 393,
                height: 852,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                borderRadius: 32,
                border: '1px solid rgba(63,63,63,.15)',
                transform: 'translateZ(0)',
                background: '#fff'
              }}
            >
              {idea.id === 'today' ? <TodayAmount /> : <AmountIdea variant={idea.id} />}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function AmountDs() {
  const frame: React.CSSProperties = {
    width: 393,
    height: 852,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: 32,
    border: '1px solid rgba(63,63,63,.15)',
    transform: 'translateZ(0)',
    background: '#fff'
  };
  const states: { label: string; initial: string }[] = [
    { label: 'Empty', initial: '' },
    { label: 'Typed', initial: '25.5' },
    { label: 'Over the balance', initial: '500' }
  ];
  return (
    <>
      <div style={{ font: "400 14px 'Nunito'", color: '#6b6b6b', marginBottom: 20 }}>
        One version, built only from the design system's own components and sizes, shown in its three states. All three are live.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {states.map(state => (
          <div key={state.label}>
            <div style={{ font: "800 14px 'Nunito'", marginBottom: 8 }}>{state.label}</div>
            <div style={frame} data-ds-state={state.label}>
              <AmountOnSystem initial={state.initial} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function AmountBoldTab() {
  const frame: React.CSSProperties = {
    width: 393,
    height: 852,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: 32,
    border: '1px solid rgba(63,63,63,.15)',
    transform: 'translateZ(0)',
    background: '#fff'
  };
  const UNKNOWN = 'mtst1arvdwvzllvg3s5fzjle7nkljeuhkcufr';
  const states: { label: string; note: string; props: React.ComponentProps<typeof AmountBold> }[] = [
    { label: 'Saved contact, empty', note: 'Keyboard up, as it opens.', props: { name: 'Maya' } },
    { label: 'Not in the address book', note: 'No name: the shortened address and the app\'s own avatar for it.', props: { address: UNKNOWN, initial: '25.5' } },
    { label: 'Over the balance', note: 'The number and the line under it turn red.', props: { name: 'Maya', initial: '500' } },
    { label: 'Keyboard dismissed', note: 'The same screen once the keyboard is put away.', props: { name: 'Maya', initial: '104.25', keyboard: false } }
  ];
  return (
    <>
      <div style={{ font: "400 14px 'Nunito'", color: '#6b6b6b', marginBottom: 20 }}>
        Designed freely in Bread's font and colours, using the phone's own keyboard. The keyboard shown is a drawing of iOS's; the real one belongs to the phone. Its keys work here.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {states.map(state => (
          <div key={state.label} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{state.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px' }}>{state.note}</div>
            <div style={frame}>
              <AmountBold {...state.props} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const REVIEWS: { id: ReviewVariant; label: string; note: string }[] = [
  { id: 'statement', label: '1. Statement', note: 'The amount screen\'s shape carried on: this much, to this person. After Phantom and Cash App.' },
  { id: 'ticket', label: '2. Ticket', note: 'One object to check: what leaves on top, who gets it below. After World App and Base.' },
  { id: 'sentence', label: '3. Sentence', note: 'What is about to happen, said in full at headline size. After Cash App and Monzo.' }
];

function ReviewTab() {
  const [known, setKnown] = useState(true);
  const [run, setRun] = useState(0);
  const frame: React.CSSProperties = {
    width: 393,
    height: 852,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: 32,
    border: '1px solid rgba(63,63,63,.15)',
    transform: 'translateZ(0)',
    background: '#fff'
  };
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          Send's review step, three free designs. Each keeps everything the real review shows. The slider works; "Advanced options" opens.
        </span>
        <button onClick={() => setKnown(value => !value)} style={tabStyle(false)}>
          Recipient: {known ? 'saved contact' : 'not in address book'} (switch)
        </button>
        <button onClick={() => setRun(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Reset
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {REVIEWS.map(review => (
          <div key={review.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{review.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px', minHeight: 36 }}>{review.note}</div>
            <div style={frame} key={`${run}-${known}`}>
              <ReviewBold
                variant={review.id}
                name={known ? 'Maya' : undefined}
                address={known ? 'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x' : 'mtst1arvdwvzllvg3s5fzjle7nkljeuhkcufr'}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const STRONG_REVIEWS: { id: ReviewTone; label: string; note: string }[] = [
  { id: 'orange', label: 'Orange', note: 'The whole screen commits: Bread orange, white figure, deep brown detail.' },
  { id: 'ink', label: 'Ink', note: 'Warm near-black, white figure, orange only where you act.' },
  { id: 'paper', label: 'Paper', note: 'White page, ink figure, orange for the path and the action.' }
];

function ReviewStrongTab() {
  const [known, setKnown] = useState(true);
  const [run, setRun] = useState(0);
  const frame: React.CSSProperties = {
    width: 393,
    height: 852,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderRadius: 32,
    border: '1px solid rgba(63,63,63,.15)',
    transform: 'translateZ(0)',
    background: '#fff'
  };
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ font: "400 14px 'Nunito'", color: '#6b6b6b' }}>
          One composition, three moods. A coin crosses from you to them while you decide. The slider works; "Advanced options" opens.
        </span>
        <button onClick={() => setKnown(value => !value)} style={tabStyle(false)}>
          Recipient: {known ? 'saved contact' : 'not in address book'} (switch)
        </button>
        <button onClick={() => setRun(n => n + 1)} style={{ ...tabStyle(false), background: '#e77537', color: '#fff' }}>
          Reset
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {STRONG_REVIEWS.map(review => (
          <div key={review.id} style={{ width: 393 }}>
            <div style={{ font: "800 14px 'Nunito'" }}>{review.label}</div>
            <div style={{ font: "400 13px 'Nunito'", color: '#6b6b6b', margin: '2px 0 8px', minHeight: 36 }}>{review.note}</div>
            <div style={frame} key={`${run}-${known}`}>
              <ReviewStrong
                tone={review.id}
                name={known ? 'Maya' : undefined}
                address={known ? 'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x' : 'mtst1arvdwvzllvg3s5fzjle7nkljeuhkcufr'}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

type Tab = 'success' | 'dapp' | 'ideas' | 'ideas2' | 'ideas3' | 'ideas4' | 'swap' | 'strong' | 'ticket' | 'styles' | 'flow' | 'amount' | 'amountds' | 'bold' | 'review' | 'review2' | 'all' | 'current' | 'flow2' | 'recipient' | 'shortcuts' | 'flow3' | 'cmpsuccess' | 'cmpshortcuts' | 'arrival' | 'micro';

const TAB_GROUPS: { title: string; tabs: [Tab, string][] }[] = [
  {
    title: 'Send flow',
    tabs: [
      ['flow3', '24 Nov version 2 (current)'],
      ['flow2', '24 Nov version 1'],
      ['current', 'App today'],
      ['flow', 'Earlier prototype'],
      ['all', 'Earlier prototype: all screens']
    ]
  },
  { title: 'Send: recipient', tabs: [['recipient', '3 versions']] },
  {
    title: 'Send: amount',
    tabs: [
      ['shortcuts', 'Shortcuts: 4 options'],
      ['bold', 'Free design'],
      ['amount', '3 versions'],
      ['amountds', 'On the design system']
    ]
  },
  {
    title: 'Send: review',
    tabs: [
      ['review2', 'Stronger'],
      ['review', '3 redesigns']
    ]
  },
  {
    title: 'Send: success',
    tabs: [
      ['arrival', 'Arrival animation: 5 options'],
      ['styles', 'In 9 styles'],
      ['ideas', 'Ideas 1'],
      ['ideas2', 'Ideas 2: rows and layout'],
      ['ideas3', 'Ideas 3: thicker and Phantom'],
      ['ideas4', 'Ideas 4: Phantom A iterated']
    ]
  },
  {
    title: 'Swap: success',
    tabs: [
      ['swap', '3 versions'],
      ['strong', '5 stronger'],
      ['ticket', 'Ticket, refined']
    ]
  },
  {
    title: 'Comparisons',
    tabs: [
      ['cmpsuccess', 'Success screens vs the majors'],
      ['cmpshortcuts', 'Amount shortcuts vs the majors']
    ]
  },
  {
    title: 'App screens',
    tabs: [
      ['micro', 'Microinteractions (app code)'],
      ['success', 'Success screens, every action'],
      ['dapp', 'dApp confirm windows']
    ]
  }
];

// The single-file export (single.ts) shows only the current Send flow, with no tab bar.
const SINGLE = SINGLE_MODE === 'flow';

function App() {
  const [tab, setTab] = useState<Tab>(location.hash === '#dapp' ? 'dapp' : location.hash === '#ideas' ? 'ideas' : location.hash === '#ideas2' ? 'ideas2' : location.hash === '#ideas3' ? 'ideas3' : location.hash === '#ideas4' ? 'ideas4' : location.hash === '#swap' ? 'swap' : location.hash === '#strong' ? 'strong' : location.hash === '#ticket' ? 'ticket' : location.hash === '#styles' ? 'styles' : location.hash === '#flow' ? 'flow' : location.hash === '#amount' ? 'amount' : location.hash === '#amountds' ? 'amountds' : location.hash === '#bold' ? 'bold' : location.hash === '#review' ? 'review' : location.hash === '#review2' ? 'review2' : location.hash === '#all' ? 'all' : location.hash === '#current' ? 'current' : location.hash === '#flow2' ? 'flow2' : location.hash === '#recipient' ? 'recipient' : location.hash === '#shortcuts' ? 'shortcuts' : location.hash === '#flow3' ? 'flow3' : location.hash === '#cmpsuccess' ? 'cmpsuccess' : location.hash === '#cmpshortcuts' ? 'cmpshortcuts' : location.hash === '#success' ? 'success' : location.hash === '#arrival' ? 'arrival' : location.hash === '#micro' ? 'micro' : 'flow3');
  const shown: Tab = SINGLE ? 'flow3' : tab;
  const pick = (next: Tab) => {
    location.hash = next;
    setTab(next);
  };
  return (
    <div style={{ padding: 24, background: '#faf9f7', minHeight: '100vh' }}>
      {/* The tabs, grouped by what they are about. Each group wraps within its own row. */}
      <div hidden={SINGLE} style={{ display: SINGLE ? 'none' : 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 10, alignItems: 'center', marginBottom: 28 }}>
        {TAB_GROUPS.map(group => (
          <React.Fragment key={group.title}>
            <div style={{ font: "800 12px 'Nunito'", letterSpacing: '0.04em', textTransform: 'uppercase', color: '#8a847c' }}>{group.title}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {group.tabs.map(([id, label]) => (
                <button key={id} onClick={() => pick(id)} style={{ ...tabStyle(tab === id), padding: '8px 14px', whiteSpace: 'nowrap' }}>
                  {label}
                </button>
              ))}
            </div>
          </React.Fragment>
        ))}
      </div>
      {shown === 'micro' ? <MicroTab /> : shown === 'success' ? <SuccessScreens /> : shown === 'swap' ? <SwapIdeas /> : shown === 'strong' ? <StrongSwap /> : shown === 'ticket' ? <TicketOnly /> : shown === 'styles' ? <SendStyles /> : shown === 'flow' ? <FlowTab /> : shown === 'amount' ? <AmountIdeas /> : shown === 'amountds' ? <AmountDs /> : shown === 'bold' ? <AmountBoldTab /> : shown === 'review' ? <ReviewTab /> : shown === 'review2' ? <ReviewStrongTab /> : shown === 'all' ? <AllScreensTab /> : shown === 'current' ? <CurrentSendFlow /> : shown === 'flow2' ? <MockFlowTab /> : shown === 'flow3' ? <MockFlowTab key="v2" variant="mock2" /> : shown === 'arrival' ? <ArrivalTab /> : shown === 'cmpsuccess' ? <ComparisonTab file="wallet-success-vs-majors.html" /> : shown === 'cmpshortcuts' ? <ComparisonTab file="wallet-amount-shortcuts-vs-majors.html" /> : shown === 'recipient' ? <RecipientIdeasTab /> : shown === 'shortcuts' ? <ShortcutIdeasTab /> : shown === 'dapp' ? <DappWork /> : shown === 'ideas' ? <Ideas /> : shown === 'ideas2' ? <Ideas2 /> : shown === 'ideas3' ? <Ideas3 /> : <Ideas4 />}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = [
  '[data-idea="c"] section.tx-stage-rise { min-height: 100%; }',
  // Review, stronger: the coin crosses the arc from you to them, rests, and goes again.
  '.review-coin { offset-path: path("M4 34 Q92 -22 180 34"); offset-rotate: 0deg; offset-anchor: center; animation: review-coin 3.2s cubic-bezier(0.65, 0, 0.35, 1) infinite; }',
  '@keyframes review-coin { 0% { offset-distance: 0%; opacity: 0; transform: scale(0.6); } 12% { opacity: 1; transform: scale(1); } 70% { offset-distance: 100%; opacity: 1; transform: scale(1); } 82%, 100% { offset-distance: 100%; opacity: 0; transform: scale(0.6); } }',
  '@media (prefers-reduced-motion: reduce) { .review-coin { animation: none; offset-distance: 50%; } }',
  // Recipient step, from the mock: each recent recipient is its own outlined card, not one grey group.
  '.proto-flow:not(.proto-mock) [data-testid="send-recent-recipients"] ul { background: transparent !important; border-radius: 0 !important; overflow: visible !important; gap: 12px !important; margin-top: 12px !important; }',
  '.proto-flow:not(.proto-mock) [data-testid="send-recent-recipients"] li > button { background: #fff !important; border: 1px solid var(--ds-hairline) !important; border-radius: 20px !important; padding: 16px !important; }',
  '.proto-flow:not(.proto-mock) [data-testid="send-recent-recipients"] li > button:active { background: var(--ds-fill) !important; }',
  // Sending in place: the coin sits as far along the arc as the work is, and glides to each new point.
  '.review-coin-travel { offset-path: path("M4 34 Q92 -22 180 34"); offset-rotate: 0deg; offset-anchor: center; transition: offset-distance 0.7s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease, transform 0.3s ease; }',
  // Amount on the design system. Two things the real field's centred mode does not do yet, shown
  // here as they should be: the fiat and error lines centre under the amount, and the unit sits on
  // the amount's baseline. And the keypad at the size the app already uses on shorter screens
  // (64px keys, 24/12px gaps), which is what leaves room for the status bar and home indicator.
  '.ds-entry .pt-2 { text-align: center !important; justify-content: center !important; }',
  '.ds-entry .cursor-text { align-items: baseline !important; }',
  '.ds-entry .cursor-text > * { align-self: baseline !important; }',
  '.ds-pad [data-testid="numpad"] { column-gap: 24px !important; row-gap: 12px !important; }',
  '.ds-pad [data-testid="numpad"] > *, .ds-pad > button { width: 64px !important; height: 64px !important; }',
  // Slide to send: a soft sheen crosses the label while it waits.
  '@keyframes slide-hint { 0%, 60% { opacity: 1; } 80% { opacity: 0.45; } 100% { opacity: 1; } }',
  '.slide-hint { animation: slide-hint 2.6s ease-in-out infinite; }',
  '@media (prefers-reduced-motion: reduce) { .slide-hint { animation: none; } }',
  // Swap colour block: the runner that crosses the track while the order fills.
  '@keyframes swap-band-run { from { left: -35%; } to { left: 100%; } }',
  '.swap-band-runner { animation: swap-band-run 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite; }',
  '@media (prefers-reduced-motion: reduce) { .swap-band-runner { animation: none; left: 0; } }',
  // Swap version 3: the pill's amounts a size down, so both names fit on one line.
  '[data-idea="s3"] .rounded-3xl .text-2xl { font-size: 17px !important; }',
  // Option 3, thicker: the values go from bold to extrabold (the labels take the card's heading face).
  '[data-idea="r3b"] .tx-stage-list .text-value { font-weight: 800 !important; }',
  // Phantom takes: everything on the left edge, and the rows lose their card.
  '[data-idea^="p"] section.tx-stage-rise > div:first-child { align-items: flex-start !important; }',
  '[data-idea^="p"] section.tx-stage-rise h2 { text-align: left !important; }',
  '[data-idea^="p"] .tx-stage-list { border-color: transparent !important; border-radius: 0 !important; }',
  '[data-idea^="p"] .tx-stage-list > * { padding-left: 0 !important; padding-right: 0 !important; }'
].join('\n');
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="user">
    <React.Suspense fallback={null}>
      <AwaitFonts name="Inter" weights={[400, 500, 600]} className="antialiased font-inter">
        <AwaitFonts name="Nunito" weights={[700, 800]}>
          <App />
        </AwaitFonts>
      </AwaitFonts>
    </React.Suspense>
  </MotionConfig>
);
