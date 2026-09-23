import { MidenNameAbortedError, MidenNameRegistryPublishingUnsupportedError, isMidenNameAbortedError } from './errors';
import { REGISTRY_PUBLISHING_SUPPORTED, accountHoldsDomainNfa, publishRegistryRecord } from './nfa';

describe('nfa stubs', () => {
  it('reports registry publishing as not supported', () => {
    expect(REGISTRY_PUBLISHING_SUPPORTED).toBe(false);
  });

  it('cannot check NFA custody yet', async () => {
    await expect(accountHoldsDomainNfa('mtst1alice', 'alice')).resolves.toBe('unsupported');
  });

  it('refuses to publish a registry record', async () => {
    await expect(publishRegistryRecord('mtst1alice', 'alice')).rejects.toThrow(
      MidenNameRegistryPublishingUnsupportedError
    );
  });
});

describe('isMidenNameAbortedError', () => {
  it('recognizes only the abort error', () => {
    expect(isMidenNameAbortedError(new MidenNameAbortedError())).toBe(true);
    expect(isMidenNameAbortedError(new Error('other'))).toBe(false);
  });
});
