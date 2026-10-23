import React from 'react';
import { ArcadeCoinsCard } from '../../src/app/templates/ArcadeCoinsCard';

/** Explicitly fictional display values; no wallet or network writes. */
export const ArcadeAllowance = () => <ArcadeCoinsCard balance="10" networkName="Testnet" />;
