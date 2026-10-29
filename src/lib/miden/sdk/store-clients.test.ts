import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Where the wallet builds clients on the SDK's IndexedDB store (#1493). `miden-client-interface.ts` builds each realm's
 * client and its realm reader (`getRealmReaderClient`), which only reads, apart from the genesis header its first build
 * may store; no other wallet source builds one, and no wallet source depends on the React SDK, whose `MidenProvider`
 * built a client of its own and synced it on every page open. Only the test dApp's React page loads it, on its own
 * origin.
 *
 * A sync on one client interleaved with a note import on another can leave a tracked block header whose MMR path is
 * too short for the checkpoint, and every later sync and import then fails. This scan sees constructors written in
 * wallet source only, not a client that a dependency builds.
 *
 * The scan reads the syntax tree, not the text, so a comment or a string, template, JSX or regex literal can neither
 * hide an opener nor fake one. It follows an import specifier or a destructuring that renames a store-class or
 * store-function export (createClientWithExternalKeystore and importStore included, even taken off a class), and it
 * catches any create*Client call by its method name on any receiver. It does not follow a class factory (create,
 * createMock, createClient) destructured off its class, a class or store function assigned to a plain const, a rename
 * made in a re-export, a computed or string-literal destructuring key, an element access, or a client that a
 * dependency builds.
 */
const ROOT = path.join(__dirname, '../../../..');
const SRC = path.join(ROOT, 'src');

// Store classes by the SDK's naming families: every *WebClient (WasmWebClient, MockWasmWebClient and its second export
// name MockWebClient) and *MidenClient export, and the wallet's MidenClientInterface. The two free functions write the
// store without a client.
const isStoreClass = (name: string) => /(?:WebClient|MidenClient)$/.test(name) || name === 'MidenClientInterface';
const STORE_FUNCTIONS = new Set(['createClientWithExternalKeystore', 'importStore']);
const isStoreExport = (name: string) => isStoreClass(name) || STORE_FUNCTIONS.has(name);
const OPENS_A_CLIENT = /^create\w*Client/;

const scriptKindFor = (fileName: string) => (fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Every expression in `source` that builds, opens or replaces a store client, spelled with the SDK's export names. */
function openersIn(source: string, fileName = 'inline.ts'): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));

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
    return name !== undefined && isStoreClass(resolve(name)) ? resolve(name) : undefined;
  };

  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const created = storeClass(node.expression);
      if (created?.endsWith('WebClient')) found.push(`new ${created}(`);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = storeClass(node.expression.expression);
      if (receiver !== undefined && !receiver.endsWith('WebClient') && method.startsWith('create')) {
        found.push(`${receiver}.${method}(`);
      } else if (OPENS_A_CLIENT.test(method)) {
        found.push(`${receiver ?? node.expression.expression.getText(file)}.${method}(`);
      } else if (method === 'importStore') {
        found.push('importStore(');
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const called = resolve(node.expression.text);
      if (STORE_FUNCTIONS.has(called)) found.push(`${called}(`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.sort();
}

const REACT_SDK = '@miden-sdk/react';
const isReactSdk = (specifier: string) => specifier === REACT_SDK || specifier.startsWith(`${REACT_SDK}/`);

const reactScriptKindFor = (fileName: string) =>
  /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

/**
 * Whether `source` imports the React SDK by a static import, an `import x = require()`, a re-export, a dynamic
 * `import()` or a `require`. A `jest.mock` string is not an import and does not count.
 */
function reactSdkImportsIn(source: string, fileName = 'inline.ts'): boolean {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, reactScriptKindFor(fileName));
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isReactSdk(node.moduleSpecifier.text)
    ) {
      found = true;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      isReactSdk(node.moduleReference.expression.text)
    ) {
      found = true;
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
      const [argument] = node.arguments;
      if (loads && argument !== undefined && ts.isStringLiteralLike(argument) && isReactSdk(argument.text))
        found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const REACT_SCANNED = fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(f => /\.[cm]?[jt]sx?$/.test(f));

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
    ['comments and strings', "// MidenClient.create(\nconst s = 'new WebClient()';\nMidenClient.ready();", []],
    ['a raw WasmWebClient', 'new WasmWebClient();', ['new WasmWebClient(']],
    ['a raw MockWasmWebClient', 'new MockWasmWebClient();', ['new MockWasmWebClient(']],
    ["the SDK's second name for the mock client", 'new MockWebClient();', ['new MockWebClient(']],
    ['an aliased mock client', "import { MockWebClient as M } from 'x';\nnew M();", ['new MockWebClient(']],
    [
      'an aliased raw class',
      "import { WasmWebClient as W } from 'x';\nW.createClient(url);",
      ['WasmWebClient.createClient(']
    ],
    ['an instance createMockClient', 'raw.createMockClient(seed);', ['raw.createMockClient(']],
    [
      'a destructured keystore factory',
      'const { createClientWithExternalKeystore: make } = WasmWebClient;\nmake(url);',
      ['createClientWithExternalKeystore(']
    ],
    [
      'an imported keystore factory',
      "import { createClientWithExternalKeystore as make } from 'x';\nmake(url);",
      ['createClientWithExternalKeystore(']
    ],
    ['an aliased importStore', "import { importStore as load } from 'x';\nload(name, dump);", ['importStore(']],
    ['a qualified importStore', 'sdk.importStore(name, dump);', ['importStore(']],
    [
      'code after a generic arrow in a .ts file',
      'const f = <T>(x: T) => x;\nMidenClient.create({});',
      ['MidenClient.create(']
    ]
  ])('reads %s', (_case, source, expected) => {
    expect(openersIn(source)).toEqual(expected);
  });

  it('parses .tsx as TSX and .ts as TS', () => {
    expect(scriptKindFor('provider.tsx')).toBe(ts.ScriptKind.TSX);
    expect(scriptKindFor('miden-client.ts')).toBe(ts.ScriptKind.TS);
  });

  it('reads past JSX text that a TS parse would take for an open string', () => {
    expect(openersIn("const a = <p>it's</p>; MidenClient.create({});", 'inline.tsx')).toEqual(['MidenClient.create(']);
  });

  it('pins every store-client construction the reader sees in wallet source', () => {
    const sites = Object.fromEntries(
      SOURCES.map(file => [file, openersIn(fs.readFileSync(path.join(SRC, file), 'utf8'), file)] as const).filter(
        ([, found]) => found.length
      )
    );
    expect(sites).toEqual({
      'lib/miden/sdk/miden-client-interface.ts': [
        'MidenClient.create(',
        'MidenClient.createMock(',
        'WasmWebClient.createClient(',
        // importDb replaces the store with a file's contents.
        'importStore('
      ],
      'lib/miden/sdk/miden-client.ts': ['MidenClientInterface.create('],
      'offscreen/main.ts': ['MidenClientInterface.create('],
      // The prove worker's client only proves and never opens a store, so a createClient on it fails here.
      'offscreen/prove-worker.ts': ['new WebClient('],
      // A guardian client factory, not the SDK's.
      'lib/miden/back/guardian-history-recovery.ts': ['context.createClient('],
      // The intercom port client that forwards a backup signal to the backend, not the SDK's.
      'lib/backup/adopt-signal.ts': ['module.createIntercomClient(']
    });
  });

  it.each([
    ['a static import', "import { MidenProvider } from '@miden-sdk/react';", true],
    ['a side-effect import', "import '@miden-sdk/react';", true],
    ['a subpath import', "import x from '@miden-sdk/react/dist/x';", true],
    ['a re-export', "export { MidenProvider } from '@miden-sdk/react';", true],
    ['a star re-export', "export * from '@miden-sdk/react';", true],
    ['a dynamic import', "const m = await import('@miden-sdk/react');", true],
    ['a require', "const m = require('@miden-sdk/react');", true],
    ['an import-equals require', "import x = require('@miden-sdk/react');", true],
    ['a template-literal dynamic import', 'export const m = () => import(`@miden-sdk/react`);', true],
    ['a jest.mock string', "jest.mock('@miden-sdk/react', () => ({}));", false],
    ['another package of the scope', "import { MidenClient } from '@miden-sdk/miden-sdk';", false],
    ['a package that only shares the prefix', "import x from '@miden-sdk/react-native';", false],
    ['a comment and a string', "// import '@miden-sdk/react';\nconst s = \"from '@miden-sdk/react'\";", false]
  ])('reads %s of the React SDK', (_name, source, imports) => {
    expect(reactSdkImportsIn(source)).toBe(imports);
  });

  it('has no wallet source depend on the React SDK, whose provider builds and syncs a client of its own', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(manifest.dependencies).not.toHaveProperty(['@miden-sdk/react']);
    const importers = REACT_SCANNED.filter(file =>
      reactSdkImportsIn(fs.readFileSync(path.join(SRC, file), 'utf8'), file)
    );
    expect(importers).toEqual([]);
  });
});
