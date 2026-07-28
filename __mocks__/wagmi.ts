import React, { FC, PropsWithChildren } from 'react';

export const WagmiProvider: FC<PropsWithChildren> = ({ children }) =>
  React.createElement(React.Fragment, null, children);
export const useDisconnect = jest.fn(() => ({ disconnect: jest.fn() }));
export const useWriteContract = jest.fn(() => ({ writeContractAsync: jest.fn() }));
