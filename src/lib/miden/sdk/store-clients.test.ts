import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Where the wallet builds clients on the SDK's IndexedDB store (#1493). `miden-client-interface.ts` builds each realm's
 * client and its realm reader (`getRealmReaderClient`), which only reads, apart from the genesis header its first build
 * may store; no other wallet source builds one, and the wallet does not depend on the React SDK, whose `MidenProvider`
 * built a client of its own and synced it on every page open.
 *
 * A sync on one client interleaved with a note import on another can leave a tracked block header whose MMR path is
 * too short for the checkpoint, and every later sync and import then fails. This scan sees constructors written in
 * wallet source only, not a client that a dependency builds.
 *
 * The scan reads the syntax tree, not the text, so a comment or a string, template, JSX or regex literal can neither
 * hide an opener nor fake one, and a binding imported or destructured under another name still counts as the SDK
 * export it names.
 */
const ROOT = path.join(__dirname, '../../../..');
const SRC = path.join(ROOT, 'src');

const STORE_CLASSES = new Set([
  'MidenClient',
  'MidenClientInterface',
  'WebClient',
  'WasmWebClient',
  'MockWasmWebClient'
]);
const KEYSTORE_FACTORY = 'createClientWithExternalKeystore';
const isStoreExport = (name: string) => STORE_CLASSES.has(name) || name === KEYSTORE_FACTORY;

/** Every expression in `source` that builds or opens a store client, spelled with the SDK's export names. */
function openersIn(source: string, fileName = 'inline.ts'): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);

  const aliases = new Map<string, string>();
  const collectAliases = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) {
      const exported = (node.propertyName ?? node.name).text;
      if (isStoreExport(exported)) aliases.set(node.name.text, exported);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const exported =
        node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName.text : node.name.text;
      if (isStoreExport(exported)) aliases.set(node.name.text, exported);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(file);

  const resolve = (name: string) => aliases.get(name) ?? name;
  const storeClass = (expression: ts.Expression) => {
    const name = ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : undefined;
    return name !== undefined && STORE_CLASSES.has(resolve(name)) ? resolve(name) : undefined;
  };

  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const created = storeClass(node.expression);
      if (created?.endsWith('WebClient')) found.push(`new ${created}(`);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = storeClass(node.expression.expression);
      if ((receiver === 'MidenClient' || receiver === 'MidenClientInterface') && method.startsWith('create')) {
        found.push(`${receiver}.${method}(`);
      } else if (method.startsWith('createClient')) {
        found.push(`${receiver ?? node.expression.expression.getText(file)}.${method}(`);
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (resolve(node.expression.text) === KEYSTORE_FACTORY) found.push(`${KEYSTORE_FACTORY}(`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.sort();
}

const SOURCES = fs
  .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('__mocks__'));

describe('clients on the SDK store', () => {
  it.each([
    ['an aliased import', "import { MidenClient as Sdk } from 'x';\nSdk.create({});", ['MidenClient.create(']],
    ['a destructured rename', 'const { WebClient: Raw } = sdk;\nnew Raw();', ['new WebClient(']],
    ['a qualified raw client', 'new sdk.WebClient();', ['new WebClient(']],
    ['a qualified factory', 'sdk.MidenClient.createMock({});', ['MidenClient.createMock(']],
    ['the wallet factory', 'MidenClientInterface.create({});', ['MidenClientInterface.create(']],
    ['an instance createClient', 'client.createClient(url);', ['client.createClient(']],
    ['a raw-class factory', 'MockWasmWebClient.createClient(url);', ['MockWasmWebClient.createClient(']],
    ['the bare keystore factory', 'createClientWithExternalKeystore(url);', ['createClientWithExternalKeystore(']],
    [
      'the keystore factory on a class',
      'WasmWebClient.createClientWithExternalKeystore(url);',
      ['WasmWebClient.createClientWithExternalKeystore(']
    ],
    [
      'code after a c8 prefix',
      '/* c8 ignore next */ await MidenClient.createTestnet({});',
      ['MidenClient.createTestnet(']
    ],
    [
      'code after a regex ending in //',
      'const r = /^https?:\\/\\//i; MidenClient.createDevnet();',
      ['MidenClient.createDevnet(']
    ],
    ['comments and strings', "// MidenClient.create(\nconst s = 'new WebClient()';\nMidenClient.ready();", []]
  ])('reads %s', (_case, source, expected) => {
    expect(openersIn(source)).toEqual(expected);
  });

  it('reads past a JSX attribute that looks like a comment', () => {
    const source = 'const a = <input accept="image/*" />;\nMidenClient.create({});\nconst b = <div>{/* c */}</div>;';
    expect(openersIn(source, 'inline.tsx')).toEqual(['MidenClient.create(']);
  });

  it('pins every store-client construction in wallet source', () => {
    const sites = Object.fromEntries(
      SOURCES.map(file => [file, openersIn(fs.readFileSync(path.join(SRC, file), 'utf8'), file)] as const).filter(
        ([, found]) => found.length
      )
    );
    expect(sites).toEqual({
      'lib/miden/sdk/miden-client-interface.ts': [
        'MidenClient.create(',
        'MidenClient.createMock(',
        'WasmWebClient.createClient('
      ],
      'lib/miden/sdk/miden-client.ts': ['MidenClientInterface.create('],
      'offscreen/main.ts': ['MidenClientInterface.create('],
      // The prove worker's client only proves and never opens a store, so a createClient on it fails here.
      'offscreen/prove-worker.ts': ['new WebClient('],
      // A guardian client factory, not the SDK's.
      'lib/miden/back/guardian-history-recovery.ts': ['context.createClient(']
    });
  });

  it('does not depend on the React SDK, whose provider builds and syncs a client of its own', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(manifest.dependencies).not.toHaveProperty(['@miden-sdk/react']);
    expect(manifest.devDependencies ?? {}).not.toHaveProperty(['@miden-sdk/react']);
  });
});
