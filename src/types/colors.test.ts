// `src/types/colors.ts` is a compile-time-only module: the exported
// `Colors` interface and `ColorCode` template-literal type both erase to
// nothing, and the module-local `_colors` const is never re-exported. Its
// entire runtime surface is therefore the top-level `import` plus the
// `const _colors = colors as Colors` assignment. Importing the module here
// executes those lines (covering the file), and the assertions below pin the
// runtime contract and exercise the type-only shapes so this file doubles as
// living documentation of the color contracts.
import type { Colors, ColorCode } from './colors';
import * as colorsModule from './colors';
import colorsData from '../utils/tailwind-colors';

describe('types/colors', () => {
  describe('module runtime surface', () => {
    it('imports without throwing and exposes no runtime exports', () => {
      // The interface, the type alias, and the local `_colors` const all
      // erase or stay module-private — nothing leaks to the runtime export
      // object beyond the (possible) esModule marker.
      const runtimeKeys = Object.keys(colorsModule).filter(k => k !== '__esModule');
      expect(runtimeKeys).toEqual([]);
    });

    it('re-exports no default value', () => {
      expect((colorsModule as { default?: unknown }).default).toBeUndefined();
    });
  });

  describe('underlying tailwind-colors data feeding the Colors type', () => {
    it('is a plain object of color-name -> shade -> hex string', () => {
      expect(typeof colorsData).toBe('object');
      expect(colorsData).not.toBeNull();
      expect(Array.isArray(colorsData)).toBe(false);
    });

    it('conforms structurally to the Colors interface', () => {
      // Structural check: every top-level key maps to a record whose values
      // are all strings — exactly what `Colors` declares.
      const typed: Colors = colorsData as Colors;
      const colorNames = Object.keys(typed);
      expect(colorNames.length).toBeGreaterThan(0);

      for (const name of colorNames) {
        const shades = typed[name]!;
        expect(typeof shades).toBe('object');
        expect(shades).not.toBeNull();

        const shadeKeys = Object.keys(shades);
        expect(shadeKeys.length).toBeGreaterThan(0);

        for (const shade of shadeKeys) {
          expect(typeof shades[shade]).toBe('string');
        }
      }
    });

    it('exposes the expected color families', () => {
      expect(Object.keys(colorsData).sort()).toEqual(['blue', 'green', 'grey', 'primary', 'red', 'yellow'].sort());
    });

    it('holds hex-formatted shade values', () => {
      const hexish = /^#[0-9a-fA-F]{3,8}$/;
      for (const shades of Object.values(colorsData as Colors)) {
        for (const value of Object.values(shades)) {
          expect(value).toMatch(hexish);
        }
      }
    });
  });

  describe('ColorCode template-literal type', () => {
    it('accepts `<colorName>-<shade>` combinations that exist in the data', () => {
      // Compile-time assertions: these only type-check because the values are
      // valid members of the `ColorCode` union. They also run at runtime as
      // trivial string equalities, keeping the type wired to real data.
      const primary500: ColorCode = 'primary-500';
      const grey900: ColorCode = 'grey-900';
      const blue50: ColorCode = 'blue-50';
      const yellow700: ColorCode = 'yellow-700';
      const green300: ColorCode = 'green-300';
      const red600: ColorCode = 'red-600';

      const samples: ColorCode[] = [primary500, grey900, blue50, yellow700, green300, red600];

      // Each sample must correspond to a real entry in the source data,
      // proving the type mirrors the runtime object.
      for (const code of samples) {
        const [name, shade] = code.split('-') as [string, string];
        const shades = (colorsData as Colors)[name];
        expect(shades).toBeDefined();
        expect(shades![shade]).toBeDefined();
      }
    });

    it('derives a code for every color/shade pair in the data', () => {
      // Build the full ColorCode set from the data and assert each string is
      // assignable to ColorCode (compile-time) while being present at runtime.
      const allCodes: ColorCode[] = [];
      for (const [name, shades] of Object.entries(colorsData as Colors)) {
        for (const shade of Object.keys(shades)) {
          allCodes.push(`${name}-${shade}` as ColorCode);
        }
      }

      expect(allCodes.length).toBeGreaterThan(0);
      expect(allCodes).toContain('primary-500');
      expect(allCodes).toContain('red-700');
      // No duplicates — each (name, shade) pair is unique.
      expect(new Set(allCodes).size).toBe(allCodes.length);
    });
  });
});
