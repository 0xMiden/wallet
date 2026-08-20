import { isAndroid, isIOS } from 'lib/platform';

import { resolveTelemetryContext } from './context';

jest.mock('lib/platform', () => ({
  isIOS: jest.fn(() => false),
  isAndroid: jest.fn(() => false)
}));

describe('resolveTelemetryContext', () => {
  afterEach(() => jest.resetAllMocks());

  it('reports the extension platform by default', () => {
    jest.mocked(isIOS).mockReturnValue(false);
    jest.mocked(isAndroid).mockReturnValue(false);
    expect(resolveTelemetryContext().platform).toBe('extension');
  });

  it('reports ios', () => {
    jest.mocked(isIOS).mockReturnValue(true);
    expect(resolveTelemetryContext().platform).toBe('ios');
  });

  it('reports android', () => {
    jest.mocked(isIOS).mockReturnValue(false);
    jest.mocked(isAndroid).mockReturnValue(true);
    expect(resolveTelemetryContext().platform).toBe('android');
  });

  it('reports a dotted semver app version', () => {
    expect(resolveTelemetryContext().appVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
