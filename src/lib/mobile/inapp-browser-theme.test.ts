/**
 * @jest-environment jsdom
 */
import { getThemeSetting } from 'lib/settings/helpers';
import { resolveTheme } from 'lib/settings/theme';

import { getInAppBrowserToolbarTheme, PREVENT_INPUT_ZOOM_SCRIPT } from './inapp-browser-theme';

jest.mock('lib/settings/helpers', () => ({
  getThemeSetting: jest.fn()
}));

jest.mock('lib/settings/theme', () => ({
  resolveTheme: jest.fn()
}));

const mockGetThemeSetting = getThemeSetting as jest.MockedFunction<typeof getThemeSetting>;
const mockResolveTheme = resolveTheme as jest.MockedFunction<typeof resolveTheme>;

describe('getInAppBrowserToolbarTheme', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetThemeSetting.mockReturnValue('system');
  });

  it('returns dark toolbar colors when the wallet theme resolves to dark', () => {
    mockResolveTheme.mockReturnValue('dark');

    expect(getInAppBrowserToolbarTheme()).toEqual({
      toolbarColor: '#191919',
      toolbarTextColor: '#FFFFFF'
    });
    expect(mockResolveTheme).toHaveBeenCalledWith('system');
  });

  it('returns light toolbar colors when the wallet theme resolves to light', () => {
    mockResolveTheme.mockReturnValue('light');

    expect(getInAppBrowserToolbarTheme()).toEqual({
      toolbarColor: '#FFFFFF',
      toolbarTextColor: '#3F3F3F'
    });
  });
});

describe('PREVENT_INPUT_ZOOM_SCRIPT', () => {
  it('pins maximum-scale=1 so iOS does not keep the page zoomed after blur', () => {
    expect(PREVENT_INPUT_ZOOM_SCRIPT).toContain('maximum-scale=1');
    expect(PREVENT_INPUT_ZOOM_SCRIPT).toContain('user-scalable=no');
    expect(PREVENT_INPUT_ZOOM_SCRIPT).toContain('__midenPreventInputZoom');
  });
});
