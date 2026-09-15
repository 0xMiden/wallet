import { UpdateController } from './controller';
import { DesktopUpdateAdapter } from './desktop';

describe('DesktopUpdateAdapter', () => {
  it('reports unknown and exposes no update action', async () => {
    await expect(new DesktopUpdateAdapter().check()).resolves.toEqual({ status: 'unknown' });
  });

  it('cannot be turned into availability by remote presentation metadata', async () => {
    const controller = new UpdateController({
      adapter: new DesktopUpdateAdapter(),
      loadManifest: async () => ({
        schemaVersion: 1,
        releases: [
          {
            version: '99.0.0',
            summary: 'Untrusted release claim.',
            urgency: 'critical',
            platforms: { desktop: { version: '99.0.0' } }
          }
        ]
      })
    });

    await expect(controller.check()).resolves.toBeNull();
  });
});
