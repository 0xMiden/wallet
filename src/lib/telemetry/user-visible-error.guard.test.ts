/** @jest-environment node */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

interface Violation {
  file: string;
  line: number;
  category: 'missing-error-id' | 'unreported-alert';
  surface?: string;
}

type Surface =
  | 'ErrorLine'
  | 'TextField'
  | 'AmountInput'
  | 'PasscodeEntry'
  | 'PasscodeScreen'
  | 'ReviewLayout'
  | 'PromptCard'
  | 'Notice'
  | 'Alert';
type Identity = { kind: 'surface'; name: Surface } | { kind: 'hook' } | { kind: 'namespace'; file: string };

const SURFACES: ReadonlyArray<{ file: string; name: Surface; exports: readonly string[] }> = [
  { file: 'src/components/ui/ErrorLine.tsx', name: 'ErrorLine', exports: ['ErrorLine'] },
  { file: 'src/components/ui/TextField.tsx', name: 'TextField', exports: ['TextField', 'default'] },
  { file: 'src/components/AmountInput.tsx', name: 'AmountInput', exports: ['AmountInput'] },
  { file: 'src/components/PasscodeEntry.tsx', name: 'PasscodeEntry', exports: ['PasscodeEntry', 'default'] },
  { file: 'src/components/PasscodeScreen.tsx', name: 'PasscodeScreen', exports: ['PasscodeScreen', 'default'] },
  { file: 'src/components/review/ReviewLayout.tsx', name: 'ReviewLayout', exports: ['ReviewLayout'] },
  { file: 'src/components/ui/PromptCard.tsx', name: 'PromptCard', exports: ['PromptCard', 'default'] },
  { file: 'src/components/ui/Notice.tsx', name: 'Notice', exports: ['Notice'] },
  { file: 'src/app/atoms/Alert.tsx', name: 'Alert', exports: ['default'] }
];
const HOOK = 'src/lib/telemetry/use-user-visible-error.ts';
const isProduction = (file: string) =>
  /^src\/.*\.tsx?$/.test(file) && !/(\.(test|spec|d)\.tsx?$|(^|\/)__(tests|mocks)__\/)/.test(file);

function scanSources(sources: ReadonlyMap<string, string>): Violation[] {
  const parsed = new Map<string, ts.SourceFile>();
  const violations: Violation[] = [];
  const parse = (file: string) => {
    let source = parsed.get(file);
    const text = sources.get(file);
    if (!source && text !== undefined) {
      source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      parsed.set(file, source);
    }
    return source;
  };
  const moduleFile = (file: string, specifier: string) => {
    const base = path.posix.normalize(
      path.posix.join(specifier.startsWith('.') ? path.posix.dirname(file) : 'src', specifier)
    );
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(candidate =>
      sources.has(candidate)
    );
  };

  const imported = (file: string, local: string, seen: ReadonlySet<string>): Identity | undefined => {
    for (const statement of parse(file)?.statements ?? []) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const target = moduleFile(file, statement.moduleSpecifier.text);
      if (!target) continue;
      if (clause.name?.text === local) return exported(target, 'default', seen);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === local) {
        return { kind: 'namespace', file: target };
      }
      if (bindings && ts.isNamedImports(bindings)) {
        const binding = bindings.elements.find(element => !element.isTypeOnly && element.name.text === local);
        if (binding) return exported(target, (binding.propertyName ?? binding.name).text, seen);
      }
    }
    return undefined;
  };

  // Resolve only import/export edges with a cycle/depth bound. Arbitrary value flow proves nothing.
  const exported = (file: string, name: string, seen: ReadonlySet<string>): Identity | undefined => {
    const key = `${file}#${name}`;
    if (seen.has(key) || seen.size >= 32) return undefined;
    const next = new Set([...seen, key]);
    const surface = SURFACES.find(entry => entry.file === file && entry.exports.includes(name));
    if (surface) return { kind: 'surface', name: surface.name };
    if (file === HOOK && name === 'useUserVisibleError') return { kind: 'hook' };
    const statements = parse(file)?.statements ?? [];
    for (const statement of statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
          if (name === 'default') return undefined;
        } else if (ts.isVariableStatement(statement)) {
          const names = new Set<string>();
          for (const declaration of statement.declarationList.declarations) boundNames(declaration.name, names);
          if (names.has(name)) return undefined;
        } else if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement) ||
            ts.isModuleDeclaration(statement)) &&
          statement.name?.text === name
        ) {
          return undefined;
        }
      }
      if (
        ts.isExportAssignment(statement) &&
        !statement.isExportEquals &&
        name === 'default' &&
        ts.isIdentifier(statement.expression)
      ) {
        return imported(file, statement.expression.text, next);
      }
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
      const target =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? moduleFile(file, statement.moduleSpecifier.text)
          : undefined;
      const clause = statement.exportClause;
      if (clause && ts.isNamespaceExport(clause) && clause.name.text === name && target) {
        return { kind: 'namespace', file: target };
      }
      if (clause && ts.isNamedExports(clause)) {
        const binding = clause.elements.find(element => !element.isTypeOnly && element.name.text === name);
        if (binding) {
          const original = (binding.propertyName ?? binding.name).text;
          return target ? exported(target, original, next) : imported(file, original, next);
        }
      }
    }
    for (const statement of statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        statement.isTypeOnly ||
        statement.exportClause ||
        name === 'default' ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const target = moduleFile(file, statement.moduleSpecifier.text);
      if (target) {
        const result = exported(target, name, next);
        if (result) return result;
      }
    }
    return undefined;
  };

  const boundNames = (name: ts.BindingName, names: Set<string>) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) boundNames(element.name, names);
  };
  const isLexicalLoop = (node: ts.Node) =>
    (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
    node.initializer !== undefined &&
    ts.isVariableDeclarationList(node.initializer) &&
    (node.initializer.flags & ts.NodeFlags.BlockScoped) !== 0;
  const scopes = new Map<ts.Node, ReadonlySet<string>>();
  const declarations = (scope: ts.Node) => {
    const cached = scopes.get(scope);
    if (cached) return cached;
    const names = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node)) boundNames(node.name, names);
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
        if (node.name) names.add(node.name.text);
        return;
      }
      if (node !== scope && isLexicalLoop(node)) {
        ts.forEachChild(node, child => {
          if (!ts.isVariableDeclarationList(child)) visit(child);
        });
        return;
      }
      if (node !== scope && (ts.isBlock(node) || ts.isFunctionLike(node) || ts.isClassLike(node))) return;
      ts.forEachChild(node, visit);
    };
    if (ts.isFunctionLike(scope)) {
      for (const parameter of scope.parameters) boundNames(parameter.name, names);
      if (ts.isFunctionExpression(scope) && scope.name) names.add(scope.name.text);
    } else if (ts.isCatchClause(scope)) {
      if (scope.variableDeclaration) boundNames(scope.variableDeclaration.name, names);
    } else visit(scope);
    scopes.set(scope, names);
    return names;
  };
  const shadowed = (name: string, node: ts.Node) => {
    for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
      if (
        (ts.isBlock(parent) || ts.isFunctionLike(parent) || ts.isCatchClause(parent) || isLexicalLoop(parent)) &&
        declarations(parent).has(name)
      ) {
        return true;
      }
    }
    return false;
  };
  const identity = (file: string, node: ts.Node): Identity | undefined => {
    if (ts.isIdentifier(node)) return shadowed(node.text, node) ? undefined : imported(file, node.text, new Set());
    if (ts.isPropertyAccessExpression(node)) {
      const owner = identity(file, node.expression);
      if (owner?.kind === 'namespace') return exported(owner.file, node.name.text, new Set());
    }
    return undefined;
  };
  const literal = (initializer: ts.JsxAttributeValue | undefined): string | undefined => {
    let value: ts.Node | undefined = initializer;
    if (value && ts.isJsxExpression(value)) value = value.expression;
    while (value && ts.isParenthesizedExpression(value)) value = value.expression;
    return value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) ? value.text : undefined;
  };

  for (const [file] of sources) {
    if (!isProduction(file)) continue;
    const source = parse(file);
    if (!source) continue;
    let hasHookCall = false;
    const documentedLines = new Set<number>();
    const openings: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
    const collect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && identity(file, node.expression)?.kind === 'hook') hasHookCall = true;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) openings.push(node);
      if (!ts.isJsxText(node)) {
        for (const comment of ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? []) {
          if (
            comment.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
            /^\/\/ not an error display: \S.*$/.test(source.text.slice(comment.pos, comment.end))
          ) {
            documentedLines.add(source.getLineAndCharacterOfPosition(comment.pos).line + 1);
          }
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    for (const opening of openings) {
      const line = source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1;
      const owner = identity(file, opening.tagName);
      const props = new Map<string, string | undefined>();
      let explicitId = false;
      let alert = false;
      for (const attribute of opening.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attribute)) {
          // Every spread is unresolved here. A later explicit prop can restore proof, never a spread-provided ID.
          for (const name of ['error', 'isError', 'status', 'tone', 'type']) props.set(name, undefined);
          explicitId = false;
        } else {
          const name = attribute.name.getText(source);
          props.set(name, literal(attribute.initializer));
          if (name === 'errorId') explicitId = true;
          if (name === 'role') alert = literal(attribute.initializer) === 'alert';
        }
      }
      if (owner?.kind === 'surface') {
        let needsId: boolean;
        switch (owner.name) {
          case 'ErrorLine':
            needsId = true;
            break;
          case 'PromptCard':
            needsId = props.has('status') && !['idle', 'loading', 'success'].includes(props.get('status') ?? '');
            break;
          case 'Notice':
            needsId = props.has('tone') && !['neutral', 'warning', 'positive'].includes(props.get('tone') ?? '');
            break;
          case 'Alert':
            needsId = props.has('type') && !['warn', 'success'].includes(props.get('type') ?? '');
            break;
          case 'PasscodeScreen':
            needsId = props.has('isError');
            break;
          default:
            needsId = props.has('error');
        }
        if (needsId && !explicitId) violations.push({ file, line, category: 'missing-error-id', surface: owner.name });
      }
      const exception = documentedLines.has(line - 1);
      const delegated = owner?.kind === 'surface' && explicitId;
      if (alert && !hasHookCall && !SURFACES.some(entry => entry.file === file) && !delegated && !exception) {
        violations.push({ file, line, category: 'unreported-alert' });
      }
    }
  }
  return violations;
}

const ROOT = path.resolve(__dirname, '../../..');
const productionSources = () =>
  new Map(
    fs
      .readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter(file => /\.(ts|tsx)$/.test(file) && !/(\.(test|spec|d)\.tsx?$|(^|\/)__(tests|mocks)__\/)/.test(file))
      .sort()
      .map(file => [`src/${file}`, fs.readFileSync(path.join(ROOT, 'src', file), 'utf8')])
  );

const fixture = (source: string, extra: Record<string, string> = {}) => {
  const sources = new Map([
    ['src/components/ui/ErrorLine.tsx', 'export const ErrorLine = () => null;'],
    ['src/components/ui/TextField.tsx', 'export const TextField = () => null; export default TextField;'],
    ['src/components/AmountInput.tsx', 'export const AmountInput = () => null;'],
    ['src/components/PasscodeEntry.tsx', 'export const PasscodeEntry = () => null; export default PasscodeEntry;'],
    ['src/components/PasscodeScreen.tsx', 'export const PasscodeScreen = () => null; export default PasscodeScreen;'],
    ['src/components/review/ReviewLayout.tsx', 'export const ReviewLayout = () => null;'],
    ['src/components/ui/PromptCard.tsx', 'export const PromptCard = () => null; export default PromptCard;'],
    ['src/components/ui/Notice.tsx', 'export const Notice = () => null;'],
    ['src/app/atoms/Alert.tsx', 'const Alert = () => null; export default Alert;'],
    ['src/lib/telemetry/use-user-visible-error.ts', 'export function useUserVisibleError() {}'],
    [
      'src/components/ui/index.ts',
      "export { ErrorLine } from './ErrorLine'; export { Notice } from './Notice'; export { TextField } from './TextField'; export { PromptCard } from './PromptCard';"
    ],
    ['src/fixture.tsx', source],
    ...Object.entries(extra)
  ]);
  return scanSources(sources).filter(violation => violation.file === 'src/fixture.tsx');
};

describe('user-visible error guard self-tests', () => {
  it('reports exact openings for paired and self-closing shared aliases', () => {
    expect(
      fixture(`import { ErrorLine as Failure } from 'components/ui';
const view = <><Failure>bad</Failure><Failure /></>;`)
    ).toEqual([
      { file: 'src/fixture.tsx', line: 2, category: 'missing-error-id', surface: 'ErrorLine' },
      { file: 'src/fixture.tsx', line: 2, category: 'missing-error-id', surface: 'ErrorLine' }
    ]);
  });

  it('ignores JSX-shaped strings, comments, unrelated imports and local same-spelling components', () => {
    expect(
      fixture(`import { ErrorLine } from 'other-package';
import { Notice } from './other';
const TextField = () => null;
const text = '<ErrorLine />';
// <ErrorLine role="alert" />
const view = <><ErrorLine /><Notice tone="negative" /><TextField error /></>;`)
    ).toEqual([]);
  });

  it('recognizes direct default imports, namespace members and renamed reexports', () => {
    expect(
      fixture(
        `import Field from './components/ui/TextField';
import * as UI from 'components/ui';
import { Renamed } from './barrel';
const view = <><Field error={false} /><UI.Notice tone={'negative'} /><Renamed /></>;`,
        { 'src/barrel.ts': "export { ErrorLine as Renamed } from './components/ui/ErrorLine';" }
      )
    ).toEqual([
      { file: 'src/fixture.tsx', line: 4, category: 'missing-error-id', surface: 'TextField' },
      { file: 'src/fixture.tsx', line: 4, category: 'missing-error-id', surface: 'Notice' },
      { file: 'src/fixture.tsx', line: 4, category: 'missing-error-id', surface: 'ErrorLine' }
    ]);
  });

  it('follows star and imported-local reexports without looping on export cycles', () => {
    expect(
      fixture(
        `import { ErrorLine, Renamed } from './barrel';
const view = <><ErrorLine /><Renamed tone="negative" /></>;`,
        {
          'src/barrel.ts':
            "export * from './cycle'; export * from './components/ui/ErrorLine'; import { Notice as N } from './components/ui/Notice'; export { N as Renamed };",
          'src/cycle.ts': "export * from './barrel';"
        }
      )
    ).toEqual([
      { file: 'src/fixture.tsx', line: 2, category: 'missing-error-id', surface: 'ErrorLine' },
      { file: 'src/fixture.tsx', line: 2, category: 'missing-error-id', surface: 'Notice' }
    ]);
  });

  it('does not confuse another export from the right module with a surface', () => {
    expect(
      fixture(`import { Other as ErrorLine } from 'components/ui/ErrorLine';
const view = <ErrorLine />;`)
    ).toEqual([]);
  });

  it('respects parameters and block bindings that shadow imported surfaces or namespaces', () => {
    expect(
      fixture(`import { ErrorLine } from 'components/ui';
import * as UI from 'components/ui';
function Local(ErrorLine, UI) { return <><ErrorLine /><UI.Notice tone="negative" /></>; }
function Block() { const ErrorLine = () => null; return <ErrorLine />; }`)
    ).toEqual([]);
  });

  it.each([
    ["import { TextField } from 'components/ui';", '<TextField error={undefined} />', 'TextField'],
    ["import { AmountInput } from 'components/AmountInput';", '<AmountInput error="bad" />', 'AmountInput'],
    ["import PasscodeEntry from 'components/PasscodeEntry';", '<PasscodeEntry error={false} />', 'PasscodeEntry'],
    ["import PasscodeScreen from 'components/PasscodeScreen';", '<PasscodeScreen isError />', 'PasscodeScreen'],
    [
      "import { ReviewLayout } from 'components/review/ReviewLayout';",
      '<ReviewLayout error={problem} />',
      'ReviewLayout'
    ],
    ["import Alert from 'app/atoms/Alert';", '<Alert type="error" description="bad" />', 'Alert']
  ])('requires an identity for the error predicate: %s %s', (imports, jsx, surface) => {
    expect(fixture(`${imports}\nconst view = ${jsx};`)).toEqual([
      { file: 'src/fixture.tsx', line: 2, category: 'missing-error-id', surface }
    ]);
  });

  it('accepts omitted nonerror predicates and documented explicit-null delegation', () => {
    expect(
      fixture(`import { TextField, Notice, PromptCard, ErrorLine } from 'components/ui';
import Alert from 'app/atoms/Alert';
// not an error display: the second accessible copy delegates to the first.
const view = <><TextField /><Notice /><PromptCard /><ErrorLine errorId={null} /><Alert type="warn" /></>;`)
    ).toEqual([]);
  });

  it.each(['idle', 'loading', 'success'])('accepts a literal %s PromptCard status in both JSX forms', status => {
    expect(
      fixture(`import { PromptCard } from 'components/ui';
const view = <><PromptCard status="${status}" /><PromptCard status={'${status}'} /></>;`)
    ).toEqual([]);
  });

  it.each(['failure', '{status}', "{ok ? 'idle' : 'failure'}"])(
    'requires an identity for failure-capable PromptCard status %s',
    status => {
      const value = status === 'failure' ? '"failure"' : status;
      expect(
        fixture(`import { PromptCard } from 'components/ui';\nconst view = <PromptCard status=${value} />;`)
      ).toEqual([{ file: 'src/fixture.tsx', line: 2, category: 'missing-error-id', surface: 'PromptCard' }]);
    }
  );

  it.each(['neutral', 'warning', 'positive'])('accepts the literal nonerror Notice tone %s', tone => {
    expect(
      fixture(`import { Notice } from 'components/ui';
const view = <><Notice tone="${tone}" /><Notice tone={'${tone}'} /></>;`)
    ).toEqual([]);
  });

  it('keeps dynamic Notice tones guarded', () => {
    expect(fixture(`import { Notice } from 'components/ui';\nconst view = <Notice tone={tone} />;`)).toEqual([
      { file: 'src/fixture.tsx', line: 2, category: 'missing-error-id', surface: 'Notice' }
    ]);
  });

  it('does not let unknown spreads prove defaults, safe status, safe tone or an explicit identity', () => {
    expect(
      fixture(`import { PromptCard, Notice, TextField, ErrorLine } from 'components/ui';
const view = <>
<PromptCard {...props} />
<PromptCard status="idle" {...props} />
<Notice tone="neutral" {...props} />
<TextField {...props} />
<ErrorLine {...{ errorId: 'bad' }} />
<Notice tone="negative" errorId="bad" {...props} />
</>;`)
    ).toEqual([
      { file: 'src/fixture.tsx', line: 3, category: 'missing-error-id', surface: 'PromptCard' },
      { file: 'src/fixture.tsx', line: 4, category: 'missing-error-id', surface: 'PromptCard' },
      { file: 'src/fixture.tsx', line: 5, category: 'missing-error-id', surface: 'Notice' },
      { file: 'src/fixture.tsx', line: 6, category: 'missing-error-id', surface: 'TextField' },
      { file: 'src/fixture.tsx', line: 7, category: 'missing-error-id', surface: 'ErrorLine' },
      { file: 'src/fixture.tsx', line: 8, category: 'missing-error-id', surface: 'Notice' }
    ]);
  });

  it('accepts final safe props and identities after unknown spreads', () => {
    expect(
      fixture(`import { PromptCard, Notice, TextField, ErrorLine } from 'components/ui';
const view = <>
<PromptCard {...props} status={'idle'} />
<Notice {...props} tone="positive" />
<TextField {...props} errorId={id} />
<ErrorLine {...props} errorId={id} />
<Notice tone="negative" {...props} errorId={id} />
</>;`)
    ).toEqual([]);
  });

  it('keeps delegated alert roles local to the shared element with its final explicit ID', () => {
    expect(
      fixture(`import { Notice } from 'components/ui';
const view = <>
<Notice role="alert" tone="negative" errorId={id} />
<p role={'alert'}>unrelated</p>
<Notice role="alert" tone="negative" errorId={id} {...props} />
</>;`)
    ).toEqual([
      { file: 'src/fixture.tsx', line: 4, category: 'unreported-alert' },
      { file: 'src/fixture.tsx', line: 5, category: 'missing-error-id', surface: 'Notice' },
      { file: 'src/fixture.tsx', line: 5, category: 'unreported-alert' }
    ]);
  });

  it.each([
    "import { useUserVisibleError as report } from './hooks'; report(id, 'inline');",
    "import * as Hooks from './hooks'; Hooks.useUserVisibleError(id, 'inline');"
  ])('accepts a resolved aliased or namespace reexport hook call: %s', proof => {
    expect(
      fixture(`${proof}\nconst view = <p role="alert">bad</p>;`, {
        'src/hooks.ts': "export { useUserVisibleError } from './lib/telemetry/use-user-visible-error';"
      })
    ).toEqual([]);
  });

  it.each([
    "import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';",
    "import { useUserVisibleError } from './other'; useUserVisibleError(id, 'inline');",
    "const useUserVisibleError = () => {}; useUserVisibleError(id, 'inline');",
    "import { useUserVisibleError as report } from 'lib/telemetry/use-user-visible-error'; function local(report) { report(id, 'inline'); }"
  ])('does not accept unused or unrelated hook proof: %s', proof => {
    expect(fixture(`${proof}\nconst view = <p role="alert">bad</p>;`)).toEqual([
      { file: 'src/fixture.tsx', line: 2, category: 'unreported-alert' }
    ]);
  });

  it('requires a genuine previous-line nonerror comment and a nonempty reason', () => {
    expect(
      fixture(`const text = '// not an error display: fake';
const one = <p role="alert">bad</p>;
// not an error display:
const two = <p role="alert">bad</p>;
// not an error display: announces the selected tab, which is not a failure.
const three = <p role="alert">selected</p>;`)
    ).toEqual([
      { file: 'src/fixture.tsx', line: 2, category: 'unreported-alert' },
      { file: 'src/fixture.tsx', line: 4, category: 'unreported-alert' }
    ]);
  });

  it('does not accept exception-shaped text inside block comments or JSX text', () => {
    expect(
      fixture(`/*
// not an error display: fake block comment */
const first = <p role="alert">bad</p>;
const second = <>
// not an error display: this is JSX text.
<p role="alert">bad</p>
</>;`)
    ).toEqual([
      { file: 'src/fixture.tsx', line: 3, category: 'unreported-alert' },
      { file: 'src/fixture.tsx', line: 6, category: 'unreported-alert' }
    ]);
  });

  it('does not delegate a native alert through an unrelated same-spelling component', () => {
    expect(
      fixture(`import { Notice } from './other';
const view = <Notice role="alert" tone="negative" errorId={id} />;`)
    ).toEqual([{ file: 'src/fixture.tsx', line: 2, category: 'unreported-alert' }]);
  });

  it('follows namespace reexports and checks the last of multiple spread positions', () => {
    expect(
      fixture(
        `import { UI } from './barrel';
const view = <>
<UI.Notice tone="negative" {...first} errorId={id} {...second} />
<UI.Notice tone="negative" {...first} {...second} errorId={id} />
</>;`,
        { 'src/barrel.ts': "export * as UI from './components/ui';" }
      )
    ).toEqual([{ file: 'src/fixture.tsx', line: 3, category: 'missing-error-id', surface: 'Notice' }]);
  });

  it('does not exempt unrelated files merely because their basename matches a definition', () => {
    expect(scanSources(new Map([['src/other/Notice.tsx', 'const view = <p role="alert">bad</p>;']]))).toEqual([
      { file: 'src/other/Notice.tsx', line: 1, category: 'unreported-alert' }
    ]);
  });

  it.each([
    'for (const ErrorLine of alternatives)',
    'for (let ErrorLine of alternatives)',
    'for (const ErrorLine in alternatives)',
    'for (let ErrorLine in alternatives)',
    'for (const ErrorLine = Local; ready;)',
    'for (let ErrorLine = Local; ready; advance())'
  ])('guards imported surfaces after a lexical loop while ignoring its local binding: %s', loop => {
    expect(
      fixture(`import { ErrorLine } from 'components/ui';
function View() {
  ${loop} {
    const local = <ErrorLine />;
  }
  return <ErrorLine />;
}`)
    ).toEqual([{ file: 'src/fixture.tsx', line: 6, category: 'missing-error-id', surface: 'ErrorLine' }]);
  });

  it.each([
    'for (var ErrorLine of alternatives)',
    'for (var ErrorLine in alternatives)',
    'for (var ErrorLine = Local; ready; advance())'
  ])('keeps function-scoped loop bindings unrelated inside and after the loop: %s', loop => {
    expect(
      fixture(`import { ErrorLine } from 'components/ui';
function View() {
  ${loop} {
    const local = <ErrorLine />;
  }
  return <ErrorLine />;
}`)
    ).toEqual([]);
  });

  it('does not waive native alerts through a var hook alias in an unbraced lexical-loop body', () => {
    expect(
      fixture(`import { useUserVisibleError as report } from './lib/telemetry/use-user-visible-error';
function View() {
  for (const item of alternatives) var report = () => undefined;
  report();
  return <p role="alert">bad</p>;
}`)
    ).toEqual([{ file: 'src/fixture.tsx', line: 5, category: 'unreported-alert' }]);
  });

  it('keeps a var surface alias in an unbraced lexical-loop body shadowed after the loop', () => {
    expect(
      fixture(`import { ErrorLine as Failure } from 'components/ui';
function View() {
  for (const item of alternatives) var Failure = () => null;
  return <Failure />;
}`)
    ).toEqual([]);
  });

  it.each([
    [
      'star then named override',
      "export * from './lib/telemetry/use-user-visible-error'; export { useUserVisibleError } from './other';"
    ],
    [
      'named override then star',
      "export { useUserVisibleError } from './other'; export * from './lib/telemetry/use-user-visible-error';"
    ],
    [
      'star then default alias override',
      "export * from './lib/telemetry/use-user-visible-error'; export { default as useUserVisibleError } from './other';"
    ],
    [
      'default alias override then star',
      "export { default as useUserVisibleError } from './other'; export * from './lib/telemetry/use-user-visible-error';"
    ],
    [
      'star then local function',
      "export * from './lib/telemetry/use-user-visible-error'; export function useUserVisibleError() {}"
    ],
    [
      'local function then star',
      "export function useUserVisibleError() {} export * from './lib/telemetry/use-user-visible-error';"
    ],
    [
      'star then local constant',
      "export * from './lib/telemetry/use-user-visible-error'; export const useUserVisibleError = () => {};"
    ],
    [
      'local constant then star',
      "export const useUserVisibleError = () => {}; export * from './lib/telemetry/use-user-visible-error';"
    ]
  ])('does not waive native alerts through an unrelated explicit hook export: %s', (_label, barrel) => {
    expect(
      fixture(
        `import { useUserVisibleError as report } from './hooks';
report(id, 'inline');
const view = <p role="alert">bad</p>;`,
        {
          'src/hooks.ts': barrel,
          'src/other.ts': 'export function useUserVisibleError() {} export default useUserVisibleError;'
        }
      )
    ).toEqual([{ file: 'src/fixture.tsx', line: 3, category: 'unreported-alert' }]);
  });

  it.each([
    "export * from './lib/telemetry/use-user-visible-error';",
    "export * from './other'; export { useUserVisibleError } from './lib/telemetry/use-user-visible-error';",
    "export { useUserVisibleError } from './lib/telemetry/use-user-visible-error'; export * from './other';"
  ])('accepts a genuine hook owner through star or overriding named exports: %s', barrel => {
    expect(
      fixture(
        `import { useUserVisibleError as report } from './hooks';
report(id, 'inline');
const view = <p role="alert">bad</p>;`,
        {
          'src/hooks.ts': barrel,
          'src/other.ts': 'export function useUserVisibleError() {}'
        }
      )
    ).toEqual([]);
  });

  it('excludes tests and mocks from the production scan', () => {
    expect(
      scanSources(
        new Map([
          ['src/example.test.tsx', '<p role="alert" />'],
          ['src/example.spec.tsx', '<p role="alert" />'],
          ['src/__mocks__/view.tsx', '<p role="alert" />']
        ])
      )
    ).toEqual([]);
  });
});

describe('user-visible error completeness', () => {
  it('requires each production shared error surface and native alert to have a reporting owner', () => {
    expect(scanSources(productionSources())).toEqual([]);
  });
});
