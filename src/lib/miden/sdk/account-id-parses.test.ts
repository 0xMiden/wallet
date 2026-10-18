/**
 * Outside `src/lib/miden/sdk/helpers.ts`, the production-source scan flags the identifier
 * `accountIdStringToSdk`, `.accountId()` called on any `<receiver>.fromBech32(...)` result, and
 * `fromBech32` calls whose receiver's last name is `AccountId` (#1384). A bare
 * `Address.fromBech32(address)` validation is not flagged. Three files are allowlisted by path:
 * `src/lib/epoch/bridge.ts` (normalizeMidenIdToHex), `src/lib/epoch/earn-withdraw-policy.ts`
 * (canonicalMidenId) and `src/lib/miden/sdk/miden-client-interface.ts` (resolveAccountId).
 * These parsers already handle hex and composite ids before their bech32 arm.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');
const HELPERS = 'src/lib/miden/sdk/helpers.ts';
const ALLOWED = new Set([
  // normalizeMidenIdToHex routes 0x/0X to fromHex and composites to accountRefToSdk.
  'src/lib/epoch/bridge.ts',
  // canonicalMidenId routes 0x/0X to fromHex and composites to accountRefToSdk.
  'src/lib/epoch/earn-withdraw-policy.ts',
  // resolveAccountId is the canonical parser over a passed WASM module.
  'src/lib/miden/sdk/miden-client-interface.ts'
]);

const repoPath = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

function bech32OnlyParses(fileName: string, text: string): string[] {
  if (fileName === HELPERS || ALLOWED.has(fileName)) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'accountIdStringToSdk') {
      found.push(`${fileName}: accountIdStringToSdk`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'accountId' &&
      ts.isCallExpression(node.expression.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression.expression) &&
      node.expression.expression.expression.name.text === 'fromBech32'
    ) {
      found.push(`${fileName}: ${node.expression.expression.expression.getText()}(...).accountId()`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'fromBech32'
    ) {
      const receiver = node.expression.expression;
      if (
        (ts.isIdentifier(receiver) && receiver.text === 'AccountId') ||
        (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'AccountId')
      ) {
        found.push(`${fileName}: ${node.expression.getText()}(...)`);
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
    'MidenAddress.fromBech32(x).accountId();'
  ])('flags exactly one parse in %s', code => {
    expect(bech32OnlyParses('src/new-parser.ts', code)).toHaveLength(1);
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
