import { defineEntry, defineSource, occurrences, readSource, viteConfigs } from './define-parity';

describe('defineSource', () => {
  it("returns the config's define object", () => {
    const source = "export default { plugins: [], define: { 'process.env.A': JSON.stringify(process.env.A ?? '') } };";
    expect(defineSource(source)).toBe("{ 'process.env.A': JSON.stringify(process.env.A ?? '') }");
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

  it('throws on an object that never closes', () => {
    expect(() => defineSource("export default { define: { 'process.env.A': 'a'")).toThrow('unbalanced');
  });

  it('throws on a trailing // comment that never closes the line', () => {
    expect(() => defineSource('export default { define: { // x')).toThrow('unbalanced');
  });

  it('throws on a /* comment that never closes', () => {
    expect(() => defineSource('export default { define: { /* x')).toThrow('unbalanced');
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

describe('readSource and viteConfigs', () => {
  it('drops whole-line // comments from a repo file', () => {
    expect(readSource('src/lib/testing/define-parity.ts')).not.toMatch(/^\s*\/\//m);
  });

  it('finds the Vite configs at the repo root', () => {
    expect(viteConfigs()).toEqual(expect.arrayContaining(['vite.extension.config.ts', 'vite.mobile.config.ts']));
  });
});
