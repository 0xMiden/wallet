import { reportUserVisibleError } from './user-visible-error';
import type { UserErrorId } from './user-visible-error-contract';

jest.mock('./user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

type BrowserAlertModule = { alertUserError?: (id: UserErrorId, message: string) => void };

function loadBrowserAlert(): BrowserAlertModule {
  try {
    require.resolve('./browser-alert');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
  return require('./browser-alert');
}

describe('browser error alert', () => {
  let alertSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
  });
  afterEach(() => alertSpy.mockRestore());

  it('preserves raw display text and reports only the closed pair after alert returns', () => {
    const { alertUserError } = loadBrowserAlert();
    expect(typeof alertUserError).toBe('function');
    if (!alertUserError) return;
    const text =
      'SDK detail 0x1234 amount 42 abandon ability able about above absent absorb abstract absurd abuse access accident';
    alertSpy.mockImplementation(() => {
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([]);
    });
    alertUserError('incorrectPassword', text);
    expect(alertSpy.mock.calls).toEqual([[text]]);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['incorrectPassword', 'browser_alert']]);
  });

  it('reports separately for separate calls without adding arguments from their copy', () => {
    const { alertUserError } = loadBrowserAlert();
    expect(typeof alertUserError).toBe('function');
    if (!alertUserError) return;
    alertUserError('incorrectPassword', 'first raw text');
    alertUserError('incorrectPassword', 'second raw text');
    expect(alertSpy.mock.calls).toEqual([['first raw text'], ['second raw text']]);
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([
      ['incorrectPassword', 'browser_alert'],
      ['incorrectPassword', 'browser_alert']
    ]);
  });
});
