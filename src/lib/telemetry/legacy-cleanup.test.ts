import { clearLegacyAnalyticsStorage } from './legacy-cleanup';

describe('clearLegacyAnalyticsStorage', () => {
  afterEach(() => localStorage.clear());

  it('removes the legacy analytics key and its persistent userId', () => {
    localStorage.setItem('analytics', JSON.stringify({ enabled: true, userId: 'abc123' }));
    clearLegacyAnalyticsStorage();
    expect(localStorage.getItem('analytics')).toBeNull();
  });

  it('is a no-op when the key is absent', () => {
    expect(() => clearLegacyAnalyticsStorage()).not.toThrow();
    expect(localStorage.getItem('analytics')).toBeNull();
  });

  it('leaves other settings untouched', () => {
    localStorage.setItem('analytics', '{}');
    localStorage.setItem('theme_setting', '"dark"');
    clearLegacyAnalyticsStorage();
    expect(localStorage.getItem('theme_setting')).toBe('"dark"');
  });
});
