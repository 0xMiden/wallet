import { COLORS } from './colors';

describe('COLORS palette', () => {
  it('exports a non-empty array of colors', () => {
    expect(Array.isArray(COLORS)).toBe(true);
    expect(COLORS.length).toBeGreaterThan(0);
  });

  it('contains exactly the expected number of swatches', () => {
    // 9 grayscale + 10 hue families x 8..9 shades. Locking the count guards
    // against accidental additions/removals slipping in unnoticed.
    expect(COLORS).toHaveLength(90);
  });

  it('is every entry a lowercase 6-digit hex color string', () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const color of COLORS) {
      expect(typeof color).toBe('string');
      expect(color).toMatch(hex);
    }
  });

  it('has no duplicate colors', () => {
    expect(new Set(COLORS).size).toBe(COLORS.length);
  });

  it('starts and ends with the documented boundary swatches', () => {
    expect(COLORS[0]).toBe('#f7fafc');
    expect(COLORS[COLORS.length - 1]).toBe('#702459');
  });

  it('includes representative swatches from each hue family', () => {
    // Spot-check one mid-tone from each Tailwind-style family so a reordering
    // that drops a whole family would be caught.
    for (const swatch of [
      '#e53e3e', // red
      '#dd6b20', // orange
      '#d69e2e', // yellow
      '#38a169', // green
      '#319795', // teal
      '#3182ce', // blue
      '#5a67d8', // indigo
      '#805ad5', // purple
      '#d53f8c' // pink
    ]) {
      expect(COLORS).toContain(swatch);
    }
  });
});
