import { defineEntry, defineSource, envReads, listSources, occurrences, readSource } from './define-parity';

describe('defineSource', () => {
  it("returns the config's define object", () => {
    const source = "export default { plugins: [], define: { 'process.env.A': JSON.stringify(process.env.A ?? '') } };";
    expect(defineSource(source)).toBe("'process.env.A': JSON.stringify(process.env.A ?? '')");
  });

  it('expands a spread from the const it names', () => {
    const source = [
      "const shared = { 'process.env.B': JSON.stringify('x') };",
      "export default { define: { ...shared, 'process.browser': 'true' } };"
    ].join('\n');
    const defines = defineSource(source);
    expect(occurrences(defines, "'process.env.B':")).toBe(1);
    expect(defines).toContain("'process.browser': 'true'");
  });

  it('expands a spread from a typed const', () => {
    const source = [
      "const shared: Record<string, string> = { 'process.env.B': JSON.stringify('x') };",
      "export default { define: { ...shared, 'process.browser': 'true' } };"
    ].join('\n');
    const defines = defineSource(source);
    expect(occurrences(defines, "'process.env.B':")).toBe(1);
  });

  it('leaves out an object the define block does not spread', () => {
    const source = [
      "const shared = { 'process.env.B': JSON.stringify('x') };",
      "export default { define: { 'process.browser': 'true' } };"
    ].join('\n');
    expect(defineSource(source)).not.toContain('process.env.B');
  });

  it('counts a key both spread and defined directly twice', () => {
    const source = [
      "const shared = { 'process.env.H': JSON.stringify('1') };",
      "export default { define: { ...shared, 'process.env.H': JSON.stringify('2') } };"
    ].join('\n');
    expect(occurrences(defineSource(source), "'process.env.H':")).toBe(2);
  });

  it('does not close the object on a brace inside a string or a comment', () => {
    const source = [
      'export default {',
      '  define: {',
      "    'process.env.C': JSON.stringify('it\\'s }'),",
      "    /* a lone } */ 'process.env.D': JSON.stringify(`}`),",
      '    \'process.env.E\': JSON.stringify("}"), // a lone {',
      "    'process.env.F': JSON.stringify('f')",
      '  },',
      "  plugins: ['after-define']",
      '};'
    ].join('\n');
    const defines = defineSource(source);
    expect(defines).toContain("'process.env.F'");
    expect(defines).not.toContain('after-define');
  });

  it('drops a define hidden only inside a comment', () => {
    const source = [
      'export default {',
      '  define: {',
      "    /* 'process.env.X': JSON.stringify('commented') */",
      "    'process.env.Y': JSON.stringify('y'), // 'process.env.Z': JSON.stringify('z')",
      "    'process.env.URL': JSON.stringify('https://x')",
      '  }',
      '};'
    ].join('\n');
    const defines = defineSource(source);
    expect(defines).not.toContain('process.env.X');
    expect(defines).not.toContain('process.env.Z');
    expect(defines).toContain("JSON.stringify('https://x')");
  });

  it('throws when the config has no define object', () => {
    expect(() => defineSource('export default { plugins: [] };')).toThrow('define');
  });

  it('throws when a spread names no const in the config', () => {
    expect(() => defineSource('export default { define: { ...missing } };')).toThrow('missing');
  });

  it('throws on a config that does not parse', () => {
    expect(() => defineSource("export default { define: { 'process.env.A': 'a'")).toThrow('does not parse');
  });

  it.each([
    ['a spread of a call', 'export default { define: { ...make() } };'],
    ['a conditional spread', 'export default { define: { ...(c ? a : b) } };'],
    ['a shorthand member', "const NODE_ENV = 'x';\nexport default { define: { NODE_ENV } };"],
    ['a method member', 'export default { define: { m() { return 1; } } };']
  ])('throws on %s, whose entries it cannot see', (_, source) => {
    expect(() => defineSource(source)).toThrow('unsupported');
  });

  it('throws on a spread of a const that is not a plain object literal', () => {
    const source = [
      "const shared = { 'process.env.B': JSON.stringify('x') } as const;",
      'export default { define: { ...shared } };'
    ].join('\n');
    expect(() => defineSource(source)).toThrow('no const shared object in the config');
  });

  it('ignores a define block inside a comment above the live one', () => {
    const source = [
      "/* define: { 'process.env.X': JSON.stringify(process.env.X ?? '') } */",
      'export default { define: {} };'
    ].join('\n');
    expect(defineSource(source)).not.toContain('process.env.X');
  });

  it('ignores a const inside a comment above the live one it spreads', () => {
    const source = [
      "/* const shared = { 'process.env.X': JSON.stringify(process.env.X ?? '') }; */",
      'const shared = {};',
      'export default { define: { ...shared } };'
    ].join('\n');
    expect(defineSource(source)).not.toContain('process.env.X');
  });

  it.each([
    [
      'the define object',
      [
        'export default {',
        '  define: {',
        "    'process.env.R': JSON.stringify(/[{']/.source),",
        "    'process.env.S': JSON.stringify('s')",
        '  },',
        "  plugins: ['after-define']",
        '};'
      ]
    ],
    [
      'the spread const',
      [
        "const shared = { 'process.env.R': JSON.stringify(/[{']/.source), 'process.env.S': JSON.stringify('s') };",
        "export default { define: { ...shared }, plugins: ['after-define'] };"
      ]
    ]
  ])('reads a regex literal inside %s as one token', (_, lines) => {
    const defines = defineSource(lines.join('\n'));
    expect(defines).toContain("'process.env.S'");
    expect(defines).not.toContain('after-define');
  });

  it.each([
    [
      'the define object',
      [
        'export default {',
        '  define: {',
        "    'process.env.A': JSON.stringify(",
        "      process.env.A ?? '' // 'process.env.B': JSON.stringify(process.env.B ?? '')",
        '    ),',
        "    'process.env.D': JSON.stringify(/* 'process.env.C': JSON.stringify('c') */ 'd')",
        '  }',
        '};'
      ]
    ],
    [
      'the spread const',
      [
        'const shared = {',
        "  'process.env.A': JSON.stringify(",
        "    process.env.A ?? '' // 'process.env.B': JSON.stringify(process.env.B ?? '')",
        '  ),',
        "  'process.env.D': JSON.stringify(/* 'process.env.C': JSON.stringify('c') */ 'd')",
        '};',
        'export default { define: { ...shared } };'
      ]
    ]
  ])('drops a comment inside an entry of %s', (_, lines) => {
    const defines = defineSource(lines.join('\n'));
    expect(defines).toMatch(defineEntry('A', "process.env.A ?? ''"));
    expect(defines).toContain("'process.env.D'");
    expect(defines).not.toContain('process.env.B');
    expect(defines).not.toContain('process.env.C');
  });

  it('throws when the config has more than one define object', () => {
    const source = [
      'export default {',
      "  optimizeDeps: { esbuildOptions: { define: { global: 'globalThis' } } },",
      "  define: { 'process.env.A': JSON.stringify('a') }",
      '};'
    ].join('\n');
    expect(() => defineSource(source)).toThrow('more than one define object');
  });
});

describe('defineEntry', () => {
  it('matches a wrapped entry', () => {
    const entry = "'process.env.G': JSON.stringify(\n    process.env.G ?? 'z'\n  )";
    expect(entry).toMatch(defineEntry('G', "process.env.G ?? 'z'"));
  });

  it('does not match another default or another env name', () => {
    const pattern = defineEntry('G', "process.env.G ?? ''");
    expect("'process.env.G': JSON.stringify('')").not.toMatch(pattern);
    expect("'process.env.G': JSON.stringify(process.env.GG ?? '')").not.toMatch(pattern);
  });
});

describe('discovery', () => {
  it('drops whole-line // comments from a repo file', () => {
    const source = readSource('src/lib/testing/define-parity.ts');
    expect(source).toContain('export const readSource');
    expect(source).not.toMatch(/^\s*\/\//m);
  });

  it('lists the env names a source reads, optional chaining included', () => {
    expect(envReads('const a = process.env.A;\nconst b = process.env?.B_2;')).toEqual(['A', 'B_2']);
  });

  it('lists the non-test modules directly in a repo directory', () => {
    const files = listSources('src/lib/testing');
    expect(files).toContain('src/lib/testing/define-parity.ts');
    expect(files.filter(file => file.includes('.test.'))).toEqual([]);
  });
});
