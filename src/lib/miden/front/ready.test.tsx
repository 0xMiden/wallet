import '../../../../test/jest-mocks';

import React from 'react';

import { renderHook, act } from '@testing-library/react';

import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import {
  useAllNetworks,
  useSetNetworkId,
  useNetwork,
  useAllAccounts,
  useAccount,
  useSettings,
  useOwnMnemonic,
  ReadyMidenProvider,
  ActivationStatus
} from './ready';

// Mock usePassiveStorage
const mockSetStoredValue = jest.fn();
let mockStoredValue = '';
jest.mock('lib/miden/front/storage', () => ({
  usePassiveStorage: jest.fn((_key: string, defaultValue: string) => {
    return [mockStoredValue || defaultValue, mockSetStoredValue];
  })
}));

describe('ready hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoredValue = '';
    mockSetStoredValue.mockClear();

    // Reset store to initial state
    useWalletStore.setState({
      status: WalletStatus.Ready,
      accounts: [],
      currentAccount: null,
      networks: [],
      settings: null,
      ownMnemonic: null,
      selectedNetworkId: null
    });
  });

  describe('ActivationStatus enum', () => {
    it('has expected values', () => {
      expect(ActivationStatus.ActivationRequestSent).toBe(0);
      expect(ActivationStatus.AlreadyActivated).toBe(1);
    });
  });

  describe('useAllNetworks', () => {
    it('returns empty array when no networks', () => {
      const { result } = renderHook(() => useAllNetworks());
      expect(result.current).toEqual([]);
    });

    it('returns networks from store', () => {
      const networks = [
        { id: 'net-1', name: 'Network 1', rpcBaseURL: 'http://rpc1', autoSync: true },
        { id: 'net-2', name: 'Network 2', rpcBaseURL: 'http://rpc2', autoSync: false }
      ];
      useWalletStore.setState({ networks });

      const { result } = renderHook(() => useAllNetworks());
      expect(result.current).toEqual(networks);
    });
  });

  describe('useSetNetworkId', () => {
    it('updates store and storage when called', () => {
      const networks = [{ id: 'net-1', name: 'Network 1', rpcBaseURL: 'http://rpc1', autoSync: true }];
      useWalletStore.setState({ networks, selectedNetworkId: null });

      const { result } = renderHook(() => useSetNetworkId());

      act(() => {
        result.current('net-1');
      });

      expect(useWalletStore.getState().selectedNetworkId).toBe('net-1');
      expect(mockSetStoredValue).toHaveBeenCalledWith('net-1');
    });
  });

  describe('useNetwork', () => {
    it('returns first network as default when no selection', () => {
      const networks = [
        { id: 'net-1', name: 'Network 1', rpcBaseURL: 'http://rpc1', autoSync: true },
        { id: 'net-2', name: 'Network 2', rpcBaseURL: 'http://rpc2', autoSync: true }
      ];
      useWalletStore.setState({ networks, selectedNetworkId: null });

      const { result } = renderHook(() => useNetwork());
      expect(result.current).toEqual(networks[0]);
    });

    it('returns selected network when set in store', () => {
      const networks = [
        { id: 'net-1', name: 'Network 1', rpcBaseURL: 'http://rpc1', autoSync: true },
        { id: 'net-2', name: 'Network 2', rpcBaseURL: 'http://rpc2', autoSync: true }
      ];
      useWalletStore.setState({ networks, selectedNetworkId: 'net-2' });

      const { result } = renderHook(() => useNetwork());
      expect(result.current).toEqual(networks[1]);
    });

    it('uses stored network ID when store selection is empty', () => {
      const networks = [
        { id: 'net-1', name: 'Network 1', rpcBaseURL: 'http://rpc1', autoSync: true },
        { id: 'net-2', name: 'Network 2', rpcBaseURL: 'http://rpc2', autoSync: true }
      ];
      mockStoredValue = 'net-2';
      useWalletStore.setState({ networks, selectedNetworkId: null });

      const { result } = renderHook(() => useNetwork());
      expect(result.current.id).toBe('net-2');
    });

    it('falls back to default when stored network ID is invalid', () => {
      const networks = [{ id: 'net-1', name: 'Network 1', rpcBaseURL: 'http://rpc1', autoSync: true }];
      mockStoredValue = 'invalid-net';
      useWalletStore.setState({ networks, selectedNetworkId: null });

      const { result } = renderHook(() => useNetwork());
      // After validation effect runs, should fall back to default
      expect(result.current.id).toBe('net-1');
    });
  });

  describe('useAllAccounts', () => {
    it('returns empty array when no accounts', () => {
      const { result } = renderHook(() => useAllAccounts());
      expect(result.current).toEqual([]);
    });

    it('returns accounts from store', () => {
      const accounts = [
        { publicKey: 'pk1', name: 'Account 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 },
        { publicKey: 'pk2', name: 'Account 2', isPublic: false, type: WalletType.OffChain, hdIndex: 1 }
      ];
      useWalletStore.setState({ accounts });

      const { result } = renderHook(() => useAllAccounts());
      expect(result.current).toEqual(accounts);
    });
  });

  describe('useAccount', () => {
    it('throws when no current account', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      useWalletStore.setState({ currentAccount: null });

      expect(() => {
        renderHook(() => useAccount());
      }).toThrow('No account selected');
      consoleErrorSpy.mockRestore();
    });

    it('returns current account when set', () => {
      const account = { publicKey: 'pk1', name: 'Account 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 };
      useWalletStore.setState({ currentAccount: account });

      const { result } = renderHook(() => useAccount());
      expect(result.current).toEqual(account);
    });

    it('dispatches reseterrorboundary event on account change', () => {
      const dispatchEventSpy = jest.spyOn(window, 'dispatchEvent');
      const account = { publicKey: 'pk1', name: 'Account 1', isPublic: true, type: WalletType.OnChain, hdIndex: 0 };
      useWalletStore.setState({ currentAccount: account });

      renderHook(() => useAccount());

      expect(dispatchEventSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
      const event = dispatchEventSpy.mock.calls[0][0] as CustomEvent;
      expect(event.type).toBe('reseterrorboundary');

      dispatchEventSpy.mockRestore();
    });
  });

  describe('useSettings', () => {
    it('throws when settings not loaded', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      useWalletStore.setState({ settings: null });

      expect(() => {
        renderHook(() => useSettings());
      }).toThrow('Settings not loaded');
      consoleErrorSpy.mockRestore();
    });

    it('returns settings when loaded', () => {
      const settings = { contacts: [{ name: 'Alice', address: 'addr1' }] };
      useWalletStore.setState({ settings });

      const { result } = renderHook(() => useSettings());
      expect(result.current).toEqual(settings);
    });
  });

  describe('useOwnMnemonic', () => {
    it('returns null when not set', () => {
      useWalletStore.setState({ ownMnemonic: null });

      const { result } = renderHook(() => useOwnMnemonic());
      expect(result.current).toBeNull();
    });

    it('returns true when own mnemonic', () => {
      useWalletStore.setState({ ownMnemonic: true });

      const { result } = renderHook(() => useOwnMnemonic());
      expect(result.current).toBe(true);
    });

    it('returns false when not own mnemonic', () => {
      useWalletStore.setState({ ownMnemonic: false });

      const { result } = renderHook(() => useOwnMnemonic());
      expect(result.current).toBe(false);
    });
  });

  describe('ReadyMidenProvider', () => {
    it('renders children without modification', () => {
      const { container } = require('@testing-library/react').render(
        <ReadyMidenProvider>
          <div data-testid="child">Hello</div>
        </ReadyMidenProvider>
      );

      expect(container.querySelector('[data-testid="child"]')).toBeTruthy();
    });
  });
});
