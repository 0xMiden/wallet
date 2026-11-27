// The Send flow as the app has it today, for comparison with the prototype. Recipient, amount and
// success are the app's own screens, rendered with fixture data. The review and processing pages
// are wired to the wallet's transaction pipeline and cannot run in a preview, so those two are
// assembled here from the app's own components in the app's arrangement.
import React, { FC, ReactNode, useState } from 'react';

import FullScreenPage from '../../../src/app/layouts/FullScreenPage';
import { TransactionSuccess } from '../../../src/screens/generating-transaction/TransactionSuccess';
import { SelectRecipient } from '../../../src/screens/send-flow/SelectRecipient';
import { SendAmount } from '../../../src/screens/send-flow/SendAmount';
import { USDCX } from './fixture';
import { AppStyleReview, Processing, RECENTS } from './flow';

const MAYA = RECENTS[0]!;
const TOKEN = { id: USDCX, name: 'USDCX', decimals: 6, balance: 140.5, fiatPrice: 1, scaleIsKnown: true };
const noop = () => undefined;

const Frame: FC<{ label: string; note?: string; children: ReactNode }> = ({ label, note, children }) => (
  <div style={{ width: 393 }}>
    <div style={{ font: "800 15px 'Nunito'", color: '#3f3f3f' }}>{label}</div>
    <div style={{ font: "600 12px 'Nunito'", color: '#8a8a8a', margin: '2px 0 8px', minHeight: 16 }}>{note}</div>
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
      {children}
    </div>
  </div>
);

const Recipient: FC<{ chosen?: boolean }> = ({ chosen }) => {
  const [address, setAddress] = useState(chosen ? MAYA.address : '');
  const known = RECENTS.find(recent => recent.address === address.trim());
  return (
    <SelectRecipient
      address={address}
      isValidAddress={address.trim() !== ''}
      chain="miden"
      network="miden"
      recipientName={known?.name}
      recents={RECENTS}
      canAddContact={false}
      onAddressChange={event => setAddress(event.target.value)}
      onAddressBook={noop}
      onAddContact={noop}
      onSelectRecent={recent => setAddress(recent.address)}
      onSelectNetwork={noop}
      onPaste={() => setAddress(MAYA.address)}
      onConfirm={noop}
    />
  );
};

const Amount: FC<{ initial: string }> = ({ initial }) => {
  const [amount, setAmount] = useState(initial);
  const numeric = Number(amount);
  return (
    <SendAmount
      token={TOKEN}
      amount={amount}
      isValidAmount={amount !== '' && numeric > 0 && numeric <= TOKEN.balance}
      recipientAddress={MAYA.address}
      recipientName={MAYA.name}
      network="miden"
      onAmountChange={setAmount}
      onSelectToken={noop}
      onReceive={noop}
      onBack={noop}
      onConfirm={noop}
    />
  );
};

export const CurrentSendFlow: FC = () => (
  <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
    <Frame label="1. Recipient" note="The app's screen">
      <Recipient />
    </Frame>
    <Frame label="2. Recipient chosen" note="The app's screen">
      <Recipient chosen />
    </Frame>
    <Frame label="3. Amount" note="The app's screen">
      <Amount initial="" />
    </Frame>
    <Frame label="4. Amount entered" note="The app's screen">
      <Amount initial="70.25" />
    </Frame>
    <Frame label="5. Review" note="Assembled from the app's components">
      <AppStyleReview amount="70.25" to={MAYA.address} isNew={false} onBack={noop} onClose={noop} onConfirm={noop} current />
    </Frame>
    <Frame label="6. Processing" note="Assembled from the app's components">
      <Processing amount="70.25" to={MAYA.address} onDone={noop} onHide={noop} />
    </Frame>
    <Frame label="7. Success" note="The app's screen, with this branch's receipt changes">
      <FullScreenPage entrance="fade">
        <TransactionSuccess
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transaction={{ id: 'fixture-tx', accountId: 'fixture-miden-account', feeAmount: 10000n, feeFaucetId: USDCX, type: 'send', amount: 70250000n, faucetId: USDCX, secondaryAccountId: MAYA.address } as any}
          txHash="0x91c4a7d2be5f3308c61e07a4"
          onDoneClick={noop}
          onViewExplorer={noop}
        />
      </FullScreenPage>
    </Frame>
  </div>
);
