import { Analytics } from '@segment/analytics-node';

import {
  WalletSendPageEventRequest,
  WalletSendPerformanceEventRequest,
  WalletSendTrackEventRequest
} from 'lib/miden/analytics-types';

if (!process.env.ALEO_WALLET_SEGMENT_WRITE_KEY) {
  throw new Error("Require a 'ALEO_WALLET_SEGMENT_WRITE_KEY' environment variable to be set");
}

const client = new Analytics({ writeKey: process.env.ALEO_WALLET_SEGMENT_WRITE_KEY });

export const trackEvent = async ({
  userId,
  event,
  category,
  properties
}: Omit<WalletSendTrackEventRequest, 'type'>) => {
  client.track({
    userId,
    event: `${category} ${event}`,
    timestamp: new Date(),
    properties: {
      ...properties,
      event,
      category
    }
  });
};

export const pageEvent = async ({
  userId,
  path,
  search,
  additionalProperties
}: Omit<WalletSendPageEventRequest, 'type'>) => {
  const url = `${path}${search}`;

  client.page({
    userId,
    name: path,
    timestamp: new Date(),
    category: 'AnalyticsEventCategory.PageOpened',
    properties: {
      url,
      path: search,
      referrer: path,
      category: 'AnalyticsEventCategory.PageOpened',

      ...additionalProperties
    }
  });
};

export const performanceEvent = async ({
  userId,
  event,
  timings,
  additionalProperties
}: Omit<WalletSendPerformanceEventRequest, 'type'>) => {
  client.track({
    userId,
    event: `Performance ${event}`,
    timestamp: new Date(),
    properties: {
      ...timings,

      ...additionalProperties
    }
  });
};
