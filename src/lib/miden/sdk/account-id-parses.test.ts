/**
 * Outside `src/lib/miden/sdk/helpers.ts`, the production-source scan flags every reference by name to
 * `accountIdStringToSdk` or `fromBech32`: an identifier with that text (a property, binding, import or call name)
 * or a string literal with that text (a computed access), whatever the receiver or wrapper (#1384). The one
 * exemption is the validation form, `Address.fromBech32(x)` called as a statement of its own with its result
 * discarded. Three functions are allowlisted by path and name, the nearest enclosing function declaration or the
 * variable an arrow or function expression initializes: normalizeMidenIdToHex in `src/lib/epoch/bridge.ts`,
 * canonicalMidenId in `src/lib/epoch/earn-withdraw-policy.ts` and resolveAccountId in
 * `src/lib/miden/sdk/miden-client-interface.ts`. These parsers already handle hex and composite ids before their
 * bech32 arm. A name built at runtime is out of the scan's reach.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');
const HELPERS = 'src/lib/miden/sdk/helpers.ts';
const ALLOWED = new Set([
  // normalizeMidenIdToHex routes 0x/0X to fromHex and composites to accountRefToSdk.
  'src/lib/epoch/bridge.ts#normalizeMidenIdToHex',
  // canonicalMidenId routes 0x/0X to fromHex and composites to accountRefToSdk.
  'src/lib/epoch/earn-withdraw-policy.ts#canonicalMidenId',
  // resolveAccountId is the canonical parser over a passed WASM module.
  'src/lib/miden/sdk/miden-client-interface.ts#resolveAccountId'
]);

const repoPath = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

const NAMES = new Set(['accountIdStringToSdk', 'fromBech32']);

function enclosingFunction(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return undefined;
}

function bech32OnlyParses(fileName: string, text: string): string[] {
  if (fileName === HELPERS) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    if (name !== undefined && NAMES.has(name) && !ALLOWED.has(`${fileName}#${enclosingFunction(node)}`)) {
      const use =
        ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent) ? node.parent : node;
      const call = ts.isCallExpression(use.parent) && use.parent.expression === use ? use.parent : undefined;
      const validation =
        call !== undefined &&
        ts.isExpressionStatement(call.parent) &&
        ts.isPropertyAccessExpression(use) &&
        ts.isIdentifier(use.expression) &&
        use.expression.text === 'Address';
      const readsAccountId =
        call !== undefined && ts.isPropertyAccessExpression(call.parent) && call.parent.name.text === 'accountId';
      if (name === 'accountIdStringToSdk') found.push(`${fileName}: accountIdStringToSdk`);
      else if (!validation) {
        found.push(
          `${fileName}: ${call ? `${use.getText()}(...)${readsAccountId ? '.accountId()' : ''}` : use.getText()}`
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['__mocks__', '__tests__', 'testing'].includes(entry.name) ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [full] : [];
  });

describe('canonical account-id parses', () => {
  it.each([
    'AccountId.fromBech32(x);',
    'wasm.AccountId.fromBech32(x);',
    'wasm.Address.fromBech32(x).accountId();',
    'MidenAddress.fromBech32(x).accountId();',
    'const Id = AccountId; Id.fromBech32(x);',
    'SdkAccountId.fromBech32(x);',
    'wasm.Address.fromBech32(x);'
  ])('flags exactly one parse in %s', code => {
    expect(bech32OnlyParses('src/new-parser.ts', code)).toHaveLength(1);
  });

  it.each([
    ['(Address.fromBech32(x)).accountId();', ['Address.fromBech32(...)']],
    ['Address.fromBech32(x)!.accountId();', ['Address.fromBech32(...)']],
    ['(Address.fromBech32(x) as Address).accountId();', ['Address.fromBech32(...)']],
    ['const a = Address.fromBech32(x);', ['Address.fromBech32(...)']],
    ['(Address.fromBech32(x));', ['Address.fromBech32(...)']],
    ["AccountId['fromBech32'](x);", ["AccountId['fromBech32'](...)"]],
    ['const parse = Address.fromBech32; parse(x).accountId();', ['Address.fromBech32']],
    ['const { fromBech32 } = AccountId; fromBech32(x);', ['fromBech32', 'fromBech32(...)']],
    ["sdk['accountIdStringToSdk'](x);", ['accountIdStringToSdk']],
    ['Address.fromBech32(address);', []],
    ['try { Address.fromBech32(address); } catch {}', []]
  ])('reports every reference by name in %s', (code, labels) => {
    expect(bech32OnlyParses('src/new-parser.ts', code)).toEqual(labels.map(label => `src/new-parser.ts: ${label}`));
  });

  it.each([
    ['src/lib/epoch/bridge.ts', 'normalizeMidenIdToHex'],
    ['src/lib/epoch/earn-withdraw-policy.ts', 'canonicalMidenId'],
    ['src/lib/miden/sdk/miden-client-interface.ts', 'resolveAccountId']
  ])('allows only the canonical parser in %s', (fileName, allowed) => {
    const parse = (name: string) => `function ${name}(w: any, x: string) { return w.AccountId.fromBech32(x); }`;
    expect(bech32OnlyParses(fileName, parse('other'))).toHaveLength(1);
    expect(bech32OnlyParses(fileName, parse(allowed))).toEqual([]);
  });

  it('detects bech32-only parses and permits only the canonical helpers and address validation', () => {
    const fileName = 'src/new-parser.ts';
    const helperCall = 'accountIdStringToSdk(x);';
    const addressCall = "Address.fromBech32(a.split('_')[0]).accountId();";
    expect(bech32OnlyParses(fileName, helperCall)).toEqual([`${fileName}: accountIdStringToSdk`]);
    expect(bech32OnlyParses('src/new-parser.tsx', addressCall)).toEqual([
      'src/new-parser.tsx: Address.fromBech32(...).accountId()'
    ]);
    expect(bech32OnlyParses(HELPERS, `${helperCall}\n${addressCall}`)).toEqual([]);
    expect(bech32OnlyParses(fileName, 'Address.fromBech32(address);')).toEqual([]);
    expect(bech32OnlyParses(fileName, `const pick = <T>(x: T) => x;\n${helperCall}`)).toEqual([
      `${fileName}: accountIdStringToSdk`
    ]);

    const files = sourceFiles(path.join(ROOT, 'src'));
    expect(files).toContain(path.join(ROOT, 'src/screens/swap-flow/SwapManager.tsx'));
    expect(files).toContain(path.join(ROOT, HELPERS));
    const offenders = files.flatMap(file => bech32OnlyParses(repoPath(file), fs.readFileSync(file, 'utf8')));
    expect(offenders.sort()).toEqual([]);
  });
});
