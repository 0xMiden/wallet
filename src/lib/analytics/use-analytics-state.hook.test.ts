import { renderHook } from '@testing-library/react';

import { AnalyticsEventCategory } from 'lib/miden/analytics-types';
import { WalletMessageType } from 'lib/shared/types';

import { sendTrackEvent, sendPageEvent, sendPerformanceEvent, useAnalyticsState } from './use-analytics-state.hook';

// Mock dependencies
const mockRequest = jest.fn();
jest.mock('../miden/front', () => ({
  request: (...args: unknown[]) => mockRequest(...args)
}));

jest.mock('lib/miden/front/local-storage', () => ({
  useLocalStorage: jest.fn((key: string, defaultValue: { enabled?: boolean; userId: string }) => {
    const state = { ...defaultValue };
    const setState = jest.fn((newState: typeof state) => {
      Object.assign(state, newState);
    });
    return [state, setState];
  })
}));

jest.mock('nanoid', () => ({
  nanoid: () => 'test-user-id'
}));

describe('useAnalyticsState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns analytics state with default values', () => {
    const { result } = renderHook(() => useAnalyticsState());

    expect(result.current.analyticsState).toEqual({
      enabled: undefined,
      userId: 'test-user-id'
    });
  });

  it('provides setAnalyticsState function', () => {
    const { result } = renderHook(() => useAnalyticsState());

    expect(typeof result.current.setAnalyticsState).toBe('function');
  });
});

describe('sendTrackEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest.mockResolvedValue(undefined);
  });

  it('sends track event request with all parameters', async () => {
    await sendTrackEvent('user-123', 'https://rpc.example.com', 'button_click', AnalyticsEventCategory.ButtonPress, {
      button: 'submit'
    });

    expect(mockRequest).toHaveBeenCalledWith({
      type: WalletMessageType.SendTrackEventRequest,
      userId: 'user-123',
      rpc: 'https://rpc.example.com',
      event: 'button_click',
      category: AnalyticsEventCategory.ButtonPress,
      properties: { button: 'submit' }
    });
  });

  it('uses General category by default', async () => {
    await sendTrackEvent('user-123', 'https://rpc.example.com', 'some_event');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        category: AnalyticsEventCategory.General
      })
    );
  });
});

describe('sendPageEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest.mockResolvedValue(undefined);
  });

  it('sends page event request with all parameters', async () => {
    await sendPageEvent('user-123', 'https://rpc.example.com', '/home', '?tab=settings', { referrer: '/login' });

    expect(mockRequest).toHaveBeenCalledWith({
      type: WalletMessageType.SendPageEventRequest,
      userId: 'user-123',
      rpc: 'https://rpc.example.com',
      path: '/home',
      search: '?tab=settings',
      additionalProperties: { referrer: '/login' }
    });
  });

  it('uses empty object for additional properties by default', async () => {
    await sendPageEvent('user-123', 'https://rpc.example.com', '/home', '');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalProperties: {}
      })
    );
  });
});

describe('sendPerformanceEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequest.mockResolvedValue(undefined);
  });

  it('sends performance event request with all parameters', async () => {
    const timings = { start: 0, end: 1000 };

    await sendPerformanceEvent('user-123', 'https://rpc.example.com', 'page_load', timings, { route: '/home' });

    expect(mockRequest).toHaveBeenCalledWith({
      type: WalletMessageType.SendPerformanceEventRequest,
      userId: 'user-123',
      rpc: 'https://rpc.example.com',
      event: 'page_load',
      timings,
      additionalProperties: { route: '/home' }
    });
  });

  it('uses empty object for additional properties by default', async () => {
    const timings = { start: 0, end: 500 };

    await sendPerformanceEvent('user-123', 'https://rpc.example.com', 'api_call', timings);

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalProperties: {}
      })
    );
  });
});
