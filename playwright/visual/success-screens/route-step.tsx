// The cross-chain send's extra step: choose how the money crosses. Each route is an outlined card
// (the flow's card style) that says how long it takes, what it costs and exactly what arrives.
// "Choose a route" and the sentence under it are the app's own wording.
import React, { FC, useState } from 'react';

import { Icon, IconName } from '../../../src/app/icons/v2';
import { ContactAvatar } from '../../../src/components/contacts/ContactAvatar';
import { NetworkLogo } from '../../../src/components/NetworkChip';
import { truncateAddress } from '../../../src/utils/string';
import { BridgeChain, BridgeRoute, routesFor } from './bridge';
import type { ProtoToken } from './tokens';

export const RouteStep: FC<{
  amount: string;
  token: ProtoToken;
  address: string;
  chain: BridgeChain;
  initial?: BridgeRoute['id'];
  onBack: () => void;
  onContinue: (route: BridgeRoute) => void;
}> = ({ amount, token, address, chain, initial, onBack, onContinue }) => {
  const routes = routesFor(token, amount, chain);
  const [picked, setPicked] = useState<BridgeRoute['id']>(routes.some(route => route.id === initial) ? initial! : routes[0]!.id);
  const route = routes.find(item => item.id === picked) ?? routes[0]!;

  return (
    <div className="flex h-full w-full flex-col bg-page px-5 pb-4 pt-4 font-heading text-ink">
      <div className="relative flex h-12 shrink-0 items-center justify-center">
        <button type="button" aria-label="Back" onClick={onBack} className="absolute left-0 flex size-11 items-center justify-center rounded-full active:bg-fill">
          <Icon name={IconName.ArrowLeft} size="md" />
        </button>
        <div className="flex max-w-[270px] items-center gap-2 rounded-full bg-fill py-1.5 pl-1.5 pr-4">
          <ContactAvatar address={address} size="sm" />
          <span className="text-[15px] font-bold text-muted">To</span>
          <span className="truncate text-[17px] font-extrabold">{truncateAddress(address, false, 6, 4)}</span>
        </div>
      </div>

      <h1 className="mt-6 text-[28px] font-black leading-9 tracking-[-0.02em]">Choose a route</h1>
      <p className="mt-1 text-[15px] font-bold leading-[22px] text-muted">Review the fee and estimated arrival before you continue.</p>

      <div role="radiogroup" aria-label="Route" className="mt-5 flex flex-col gap-3">
        {routes.map(item => {
          const selected = item.id === picked;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setPicked(item.id)}
              className="rounded-[20px] bg-page p-4 text-left transition-shadow duration-150"
              style={{ boxShadow: selected ? 'inset 0 0 0 2px var(--accent-primary)' : 'inset 0 0 0 1px var(--ds-hairline)' }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[17px] font-black leading-6">{item.label}</span>
                <span
                  className="flex size-6 shrink-0 items-center justify-center rounded-full"
                  style={selected ? { background: 'var(--accent-primary)' } : { boxShadow: 'inset 0 0 0 2px var(--ds-fill-pressed)' }}
                >
                  {selected && (
                    <svg width="14" height="14" viewBox="0 0 44 44" fill="none">
                      <path d="M11 23L18.5 30.5L33 15" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
              </div>
              <div className="mt-0.5 text-[13px] font-bold leading-[18px] text-muted">
                {item.eta} · {item.fee}
              </div>
              <div className="mt-3 flex items-end justify-between gap-3 border-t border-hairline pt-3">
                <span className="text-[13px] font-extrabold leading-5 text-muted">You receive</span>
                <span className="flex items-center gap-1.5 text-[19px] font-black leading-6">
                  {item.receive} {item.receiveSymbol}
                  <span className="text-[13px] font-extrabold text-muted">on</span>
                  <NetworkLogo kind="ethereum" network={chain.id} />
                  <span className="text-[15px] font-extrabold">{chain.name}</span>
                </span>
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[13px] font-bold leading-[18px] text-muted">{route.note}</p>

      <button
        type="button"
        onClick={() => onContinue(route)}
        className="mt-auto h-14 w-full shrink-0 rounded-full text-[19px] font-extrabold text-white"
        style={{ background: 'var(--accent-primary)' }}
      >
        Continue
      </button>
    </div>
  );
};
