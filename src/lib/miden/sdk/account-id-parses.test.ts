/**
 * Account ids reach the wallet as bech32 addresses, composite `<address>_<suffix>` public keys and hex in
 * either prefix case. Only `accountRefToSdk` and `walletAccountIdToSdk` accept all of them, so outside
 * `helpers.ts` no file may name the bech32-only `accountIdStringToSdk` or take `.accountId()` of an
 * `Address.fromBech32(...)` call (#1384). A bare `Address.fromBech32(address)` that only validates a typed
 * address is not a parse and is not flagged.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');
const HELPERS = 'src/lib/miden/sdk/helpers.ts';

const repoPath = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

function bech32OnlyParses(fileName: string, text: string): string[] {
  if (fileName === HELPERS) return [];
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
      node.expression.expression.expression.name.text === 'fromBech32' &&
      ts.isIdentifier(node.expression.expression.expression.expression) &&
      node.expression.expression.expression.expression.text === 'Address'
    ) {
      found.push(`${fileName}: Address.fromBech32(...).accountId()`);
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
