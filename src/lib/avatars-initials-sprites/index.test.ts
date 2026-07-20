import Color from '@dicebear/avatars/lib/color';
import Random from '@dicebear/avatars/lib/random';

import initialsSprites from './index';

// The dicebear `Random` is deterministic (seedrandom-backed) and its `Color`
// collection is a real, non-mocked dependency, so we can assert on exact SVG
// output. When `backgroundColors` filters down to a single collection entry,
// `random.pickone` is forced to return that entry, which lets us assert the
// exact `fill` colour without depending on the PRNG.

/** All level-600 colours (the default level) across the whole collection. */
const allLevel600 = Object.keys(Color.collection).map(
  (name) => (Color.collection as any)[name][600] as string
);

/** Extract the `fill` value of the background `<rect>` from a generated SVG. */
function rectFill(svg: string): string {
  const match = /<rect width="1" height="1" fill="([^"]*)">/.exec(svg);
  if (!match) throw new Error(`no background rect found in: ${svg}`);
  return match[1];
}

/** Extract the inner text of the `<text>` element. */
function textContent(svg: string): string {
  const match = /<text[^>]*>([^<]*)<\/text>/.exec(svg);
  if (!match) throw new Error(`no <text> found in: ${svg}`);
  return match[1];
}

describe('initialsSprites', () => {
  describe('defaults (no options)', () => {
    it('produces a well-formed SVG with the default level/font/chars', () => {
      const svg = initialsSprites(new Random('AB'));

      expect(svg).toContain(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="isolation:isolate;" viewBox="0 0 1 1" version="1.1">'
      );
      expect(svg.endsWith('</svg>')).toBe(true);

      // Default font size is 50 -> 0.5px.
      expect(svg).toContain('font-size: 0.5px');
      expect(svg).toContain('font-family: Menlo,Monaco,monospace');
      expect(svg).toContain('fill="#FFF"');

      // Default background comes from the full collection at level 600.
      expect(allLevel600).toContain(rectFill(svg));

      // Default chars = 2 -> first two chars of the seed.
      expect(textContent(svg)).toBe('AB');

      // No margin -> no transform groups.
      expect(svg).not.toContain('<g transform');
      // Not bold by default.
      expect(svg).not.toContain('font-weight: bold;');
    });

    it('uses an explicit empty backgroundColors array as "all colours"', () => {
      // Empty array hits the `.length === 0` branch (not the `indexOf` one).
      const svg = initialsSprites(new Random('ZZ'), { backgroundColors: [] });
      expect(allLevel600).toContain(rectFill(svg));
    });
  });

  describe('explicit background', () => {
    it('uses the provided background verbatim and clears the option', () => {
      const options: any = { background: '#123456' };
      const svg = initialsSprites(new Random('AB'), options);

      expect(rectFill(svg)).toBe('#123456');
      // Side effect: the source sets options.background back to undefined.
      expect(options.background).toBeUndefined();
    });
  });

  describe('backgroundColors filter + backgroundColorLevel', () => {
    it('restricts to a single named colour at the default level (600)', () => {
      const svg = initialsSprites(new Random('AB'), {
        backgroundColors: ['amber'],
      });
      // Single-element pool -> pickone is forced to return amber[600].
      expect(rectFill(svg)).toBe((Color.collection as any).amber[600]);
    });

    it('honours an explicit backgroundColorLevel', () => {
      const svg = initialsSprites(new Random('AB'), {
        backgroundColors: ['blue'],
        backgroundColorLevel: 300,
      });
      expect(rectFill(svg)).toBe((Color.collection as any).blue[300]);
    });

    it('excludes colours not present in the filter list', () => {
      const svg = initialsSprites(new Random('AB'), {
        backgroundColors: ['amber'],
      });
      const fill = rectFill(svg);
      // Every non-amber level-600 colour must be excluded.
      const otherColours = Object.keys(Color.collection)
        .filter((name) => name !== 'amber')
        .map((name) => (Color.collection as any)[name][600]);
      expect(otherColours).not.toContain(fill);
    });
  });

  describe('margin', () => {
    it('wraps the text in translate/scale groups and clears the option', () => {
      const options: any = { margin: 10, background: '#000000' };
      const svg = initialsSprites(new Random('AB'), options);

      // margin/100 = 0.1 ; 1 - (10*2)/100 = 0.8
      expect(svg).toContain('<g transform="translate(0.1, 0.1)">');
      expect(svg).toContain('<g transform="scale(0.8)">');
      // Two opening groups -> two closing groups.
      expect((svg.match(/<\/g>/g) || []).length).toBe(2);

      // Side effect: margin is reset to undefined.
      expect(options.margin).toBeUndefined();
    });

    it('emits no transform groups when margin is absent', () => {
      const svg = initialsSprites(new Random('AB'), { background: '#000000' });
      expect(svg).not.toContain('<g transform');
      expect(svg).not.toContain('</g>');
    });
  });

  describe('bold', () => {
    it('adds font-weight when bold is true', () => {
      const svg = initialsSprites(new Random('AB'), {
        bold: true,
        background: '#000000',
      });
      expect(svg).toContain('font-weight: bold;');
    });

    it('omits font-weight when bold is false', () => {
      const svg = initialsSprites(new Random('AB'), {
        bold: false,
        background: '#000000',
      });
      expect(svg).not.toContain('font-weight: bold;');
    });
  });

  describe('fontSize', () => {
    it('divides the explicit font size by 100', () => {
      const svg = initialsSprites(new Random('AB'), {
        fontSize: 25,
        background: '#000000',
      });
      expect(svg).toContain('font-size: 0.25px');
    });
  });

  describe('chars + seed handling', () => {
    it('slices the seed to the default of 2 chars', () => {
      const svg = initialsSprites(new Random('ABCDEF'), { background: '#000000' });
      expect(textContent(svg)).toBe('AB');
    });

    it('honours an explicit chars count', () => {
      const svg = initialsSprites(new Random('ABCDEF'), {
        chars: 3,
        background: '#000000',
      });
      expect(textContent(svg)).toBe('ABC');
    });

    it('trims leading/trailing whitespace before slicing', () => {
      const svg = initialsSprites(new Random('   XY   '), {
        background: '#000000',
      });
      expect(textContent(svg)).toBe('XY');
    });

    it('strips angle brackets from the initials to avoid markup injection', () => {
      const svg = initialsSprites(new Random('  <a>  '), {
        chars: 5,
        background: '#000000',
      });
      // trim -> '<a>' ; slice(0,5) -> '<a>' ; strip < and > -> 'a'
      expect(textContent(svg)).toBe('a');
    });
  });
});
