import { isExtension } from 'lib/platform';

// Lazy-loaded IntercomServer (only in extension context)
let _intercom: import('lib/intercom/server').IntercomServer | null = null;

export function getIntercom() {
  if (!isExtension()) {
    throw new Error('IntercomServer is only available in extension context');
  }
  if (!_intercom) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { IntercomServer } = require('lib/intercom/server');
    _intercom = new IntercomServer();
  }
  return _intercom;
}

// For backward compatibility - lazy getter
export const intercom = {
  get instance() {
    return getIntercom();
  },
  onRequest: (...args: Parameters<import('lib/intercom/server').IntercomServer['onRequest']>) => {
    return getIntercom()!.onRequest(...args);
  },
  broadcast: (...args: Parameters<import('lib/intercom/server').IntercomServer['broadcast']>) => {
    return getIntercom()!.broadcast(...args);
  },
  hasClients: () => {
    return getIntercom()!.hasClients();
  }
};

export class PublicError extends Error {}
