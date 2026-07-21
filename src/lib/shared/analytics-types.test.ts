import {
  AnalyticsEventCategory,
  AnalyticsEventEnum,
  PerformanceTimings,
  SendPageEventRequest,
  SendPageEventResponse,
  SendPerformanceEventRequest,
  SendPerformanceEventResponse,
  SendTrackEventRequest,
  SendTrackEventResponse
} from './analytics-types';
import { WalletMessageType } from './types';

describe('analytics-types', () => {
  describe('AnalyticsEventCategory enum', () => {
    it('maps every member to its string value', () => {
      expect(AnalyticsEventCategory.General).toBe('General');
      expect(AnalyticsEventCategory.ButtonPress).toBe('ButtonPress');
      expect(AnalyticsEventCategory.Toggle).toBe('Toggle');
      expect(AnalyticsEventCategory.FormChange).toBe('FormChange');
      expect(AnalyticsEventCategory.FormSubmit).toBe('FormSubmit');
      expect(AnalyticsEventCategory.FormSubmitSuccess).toBe('FormSubmitSuccess');
      expect(AnalyticsEventCategory.FormSubmitFail).toBe('FormSubmitFail');
      expect(AnalyticsEventCategory.PageOpened).toBe('PageOpened');
      expect(AnalyticsEventCategory.PageClosed).toBe('PageClosed');
    });

    it('is a string-valued enum with exactly the expected members', () => {
      expect(Object.keys(AnalyticsEventCategory)).toEqual([
        'General',
        'ButtonPress',
        'Toggle',
        'FormChange',
        'FormSubmit',
        'FormSubmitSuccess',
        'FormSubmitFail',
        'PageOpened',
        'PageClosed'
      ]);
      // String enums are not reverse-mapped, so values equal the key set here.
      expect(Object.values(AnalyticsEventCategory)).toEqual(Object.keys(AnalyticsEventCategory));
      Object.values(AnalyticsEventCategory).forEach(value => {
        expect(typeof value).toBe('string');
      });
    });
  });

  describe('AnalyticsEventEnum enum', () => {
    it('maps every member to its string value', () => {
      expect(AnalyticsEventEnum.AnalyticsEnabled).toBe('AnalyticsEnabled');
      expect(AnalyticsEventEnum.AnalyticsDisabled).toBe('AnalyticsDisabled');
      expect(AnalyticsEventEnum.LanguageChanged).toBe('LanguageChanged');
      expect(AnalyticsEventEnum.FiatCurrencyChanged).toBe('FiatCurrencyChanged');
    });

    it('exposes exactly the expected members', () => {
      expect(Object.keys(AnalyticsEventEnum)).toEqual([
        'AnalyticsEnabled',
        'AnalyticsDisabled',
        'LanguageChanged',
        'FiatCurrencyChanged'
      ]);
      Object.values(AnalyticsEventEnum).forEach(value => {
        expect(typeof value).toBe('string');
      });
    });
  });

  describe('message payload shapes', () => {
    it('builds a SendTrackEventRequest / Response pair (with optional properties)', () => {
      const withProps: SendTrackEventRequest = {
        type: WalletMessageType.SendTrackEventRequest,
        userId: 'user-1',
        rpc: 'https://rpc.example',
        event: AnalyticsEventEnum.AnalyticsEnabled,
        category: AnalyticsEventCategory.ButtonPress,
        properties: { foo: 'bar' }
      };
      expect(withProps.type).toBe(WalletMessageType.SendTrackEventRequest);
      expect(withProps.category).toBe(AnalyticsEventCategory.ButtonPress);
      expect(withProps.properties).toEqual({ foo: 'bar' });

      // rpc may be undefined and properties is optional.
      const withoutProps: SendTrackEventRequest = {
        type: WalletMessageType.SendTrackEventRequest,
        userId: 'user-2',
        rpc: undefined,
        event: AnalyticsEventEnum.AnalyticsDisabled,
        category: AnalyticsEventCategory.General
      };
      expect(withoutProps.rpc).toBeUndefined();
      expect(withoutProps.properties).toBeUndefined();

      const response: SendTrackEventResponse = {
        type: WalletMessageType.SendTrackEventResponse
      };
      expect(response.type).toBe(WalletMessageType.SendTrackEventResponse);
    });

    it('builds a SendPageEventRequest / Response pair', () => {
      const request: SendPageEventRequest = {
        type: WalletMessageType.SendPageEventRequest,
        userId: 'user-3',
        rpc: 'https://rpc.example',
        path: '/settings',
        search: '?tab=general',
        additionalProperties: { referrer: 'home' }
      };
      expect(request.path).toBe('/settings');
      expect(request.search).toBe('?tab=general');
      expect(request.additionalProperties).toEqual({ referrer: 'home' });

      const response: SendPageEventResponse = {
        type: WalletMessageType.SendPageEventResponse
      };
      expect(response.type).toBe(WalletMessageType.SendPageEventResponse);
    });

    it('builds a SendPerformanceEventRequest / Response pair with PerformanceTimings', () => {
      const timings: PerformanceTimings = {
        proofGeneration: 1200,
        submission: 340
      };
      const request: SendPerformanceEventRequest = {
        type: WalletMessageType.SendPerformanceEventRequest,
        userId: 'user-4',
        rpc: undefined,
        event: 'proof',
        timings,
        additionalProperties: { network: 'testnet' }
      };
      expect(request.timings.proofGeneration).toBe(1200);
      expect(request.timings.submission).toBe(340);
      expect(request.rpc).toBeUndefined();
      expect(request.additionalProperties).toEqual({ network: 'testnet' });

      const response: SendPerformanceEventResponse = {
        type: WalletMessageType.SendPerformanceEventResponse
      };
      expect(response.type).toBe(WalletMessageType.SendPerformanceEventResponse);
    });
  });
});
