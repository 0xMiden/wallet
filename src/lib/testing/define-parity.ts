import fs from 'fs';
import path from 'path';
import ts from 'typescript';

// Shared by the build-define parity suites: dApp-bridge debug flags, telemetry keys and the update flag.
const REPO_ROOT = path.join(__dirname, '../../..');

/** A repo-root file with whole-line `//` comments dropped, so a define, spread or env read commented out counts as absent. */
export const readSource = (relative: string) =>
  fs
    .readFileSync(path.join(REPO_ROOT, relative), 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

/** Every Vite config at the repo root, sorted. */
export const viteConfigs = () =>
  fs
    .readdirSync(REPO_ROOT)
    .filter(file => /^vite\..+\.config\.ts$/.test(file))
    .sort();

/** The env names a source reads as `process.env.X` or `process.env?.X`. */
export const envReads = (source: string) =>
  [...source.matchAll(/process\.env\??\.([A-Z0-9_]+)/g)].map(match => match[1]!);

/** The non-test `.ts`/`.tsx` modules directly in a repo-relative directory, as repo-relative paths. */
export const listSources = (dir: string) =>
  fs
    .readdirSync(path.join(REPO_ROOT, dir))
    .filter(file => /\.tsx?$/.test(file) && !file.includes('.test.'))
    .map(file => `${dir}/${file}`);

/** A key defined twice in one config: the later entry wins in the object literal, so it must appear once. */
export const occurrences = (content: string, token: string) => content.split(token).length - 1;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A define's whole entry, key through the closing parenthesis, with any whitespace a wrapped entry adds. */
export const defineEntry = (key: string, expression: string) =>
  new RegExp(`'process\\.env\\.${key}':\\s*JSON\\.stringify\\(\\s*${escapeRegExp(expression)}\\s*\\)`);

// Comments are dropped from each entry as it is printed, so a key commented out anywhere inside the
// object, even within a wrapped initializer, cannot still match; string and regex literals keep their text.
const printer = ts.createPrinter({ removeComments: true });

const propertyName = (member: ts.PropertyAssignment) =>
  ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;

function constObject(name: string, file: ts.SourceFile): ts.ObjectLiteralExpression {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const { name: declared, initializer } = declaration;
      if (
        ts.isIdentifier(declared) &&
        declared.text === name &&
        initializer &&
        ts.isObjectLiteralExpression(initializer)
      ) {
        return initializer;
      }
    }
  }
  throw new Error(`no const ${name} object in the config`);
}

// Any other member (a shorthand, a method, a spread of a call or a conditional) contributes entries the
// suites cannot see, so it is refused rather than skipped.
function entries(object: ts.ObjectLiteralExpression, file: ts.SourceFile): string[] {
  return object.properties.flatMap(member => {
    if (ts.isPropertyAssignment(member)) return [printer.printNode(ts.EmitHint.Unspecified, member, file)];
    if (ts.isSpreadAssignment(member) && ts.isIdentifier(member.expression)) {
      return entries(constObject(member.expression.text, file), file);
    }
    throw new Error(`unsupported define member: ${member.getText(file)}`);
  });
}

/**
 * What reaches Vite's `define`: the entries of the config's one `define: {...}` object, each `...name`
 * spread in it replaced by the entries of the top-level `const name = {...}`, one entry per line. Read
 * from a TypeScript parse, so a define block, const or entry inside a comment is not in the result.
 * Throws when the source does not parse, has no define object or more than one (e.g. a nested
 * `optimizeDeps.esbuildOptions.define`), or spreads something other than a const object literal.
 */
export function defineSource(configSource: string): string {
  // createSourceFile recovers from syntax errors instead of throwing, so a truncated config is caught here.
  if (ts.transpileModule(configSource, { reportDiagnostics: true }).diagnostics?.length) {
    throw new Error('the config does not parse');
  }
  const file = ts.createSourceFile('config.ts', configSource, ts.ScriptTarget.Latest, true);
  const defines: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node) === 'define' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      defines.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (defines.length === 0) throw new Error('no define object in the config');
  if (defines.length > 1) throw new Error('the config has more than one define object');
  return entries(defines[0]!, file).join('\n');
}
