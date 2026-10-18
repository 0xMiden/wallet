import ts from 'typescript';

import type { DappServer } from './test-dapp-server';

/**
 * The module graph a test dApp page loads, read the way the browser links it: every module the import map and the
 * relative specifiers reach, through the server that serves the page. A browser that meets a missing file, an
 * unmapped bare specifier or a named import the target lacks refuses to link the whole page, which a run reports only
 * as a page that never became ready; this reports it as the module and the name.
 */

interface ModuleImport {
  specifier: string;
  /** Imported or re-exported names; `default` for a default import. */
  names: string[];
  dynamic: boolean;
}
interface ModuleFacts {
  imports: ModuleImport[];
  exports: Set<string>;
  /** Specifiers of `export * from`. */
  stars: string[];
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === kind);

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(element => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

function factsOf(source: string, url: string): ModuleFacts {
  const file = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const facts: ModuleFacts = { imports: [], exports: new Set(), stars: [] };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const names: string[] = [];
      if (clause !== undefined && !clause.isTypeOnly) {
        if (clause.name !== undefined) names.push('default');
        if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
          }
        }
      }
      facts.imports.push({ specifier: statement.moduleSpecifier.text, names, dynamic: false });
    } else if (ts.isExportDeclaration(statement)) {
      const from = statement.moduleSpecifier;
      const clause = statement.exportClause;
      if (from !== undefined && ts.isStringLiteral(from)) {
        const names =
          clause !== undefined && ts.isNamedExports(clause)
            ? clause.elements.map(e => (e.propertyName ?? e.name).text)
            : [];
        facts.imports.push({ specifier: from.text, names, dynamic: false });
        if (clause === undefined) facts.stars.push(from.text);
      }
      if (clause !== undefined && ts.isNamedExports(clause))
        for (const element of clause.elements) facts.exports.add(element.name.text);
      if (clause !== undefined && ts.isNamespaceExport(clause)) facts.exports.add(clause.name.text);
    } else if (ts.isExportAssignment(statement)) {
      facts.exports.add('default');
    } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) facts.exports.add('default');
      else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const name of bindingNames(declaration.name)) facts.exports.add(name);
        }
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        facts.exports.add(statement.name.text);
      }
    }
  }
  // A dynamic import of a bare specifier links nothing up front, so only the first call to it would fail.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        facts.imports.push({ specifier: argument.text, names: [], dynamic: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return facts;
}

/** Every name a module source exports by itself, not through `export *`. */
export function exportedNames(source: string): string[] {
  return [...factsOf(source, 'module.js').exports].sort();
}

/** The specifiers a module source imports statically, in source order. */
export function importedSpecifiers(source: string): string[] {
  return factsOf(source, 'module.js')
    .imports.filter(entry => !entry.dynamic)
    .map(entry => entry.specifier);
}

/**
 * What would stop the browser linking the graph from `entries`, as one line each: a module the server does not serve,
 * a bare specifier the import map lacks (dynamic imports included), and a named or default import its target does not
 * export. Empty when the graph links.
 */
export function linkProblems(server: Pick<DappServer, 'serve' | 'importMap'>, entries: readonly string[]): string[] {
  const problems = new Set<string>();
  const graph = new Map<string, ModuleFacts>();
  const resolve = (specifier: string, from: string): string | undefined => {
    if (specifier.startsWith('/')) return specifier;
    if (specifier.startsWith('./') || specifier.startsWith('../'))
      return new URL(specifier, `http://dapp${from}`).pathname;
    return server.importMap.imports[specifier];
  };
  const queue = [...entries];
  for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
    if (graph.has(url)) continue;
    const served = server.serve(url);
    if (served.status !== 200) {
      problems.add(`${url} answers ${served.status}: ${served.body.toString('utf8').slice(0, 200)}`);
      continue;
    }
    const facts = factsOf(served.body.toString('utf8'), url);
    graph.set(url, facts);
    for (const entry of facts.imports) {
      const target = resolve(entry.specifier, url);
      if (target === undefined) problems.add(`${url} imports ${entry.specifier}, which the import map lacks`);
      else queue.push(target);
    }
  }
  const exportsOf = (url: string, seen: ReadonlySet<string>): Set<string> => {
    const facts = graph.get(url);
    const names = new Set(facts?.exports ?? []);
    for (const star of facts?.stars ?? []) {
      const target = resolve(star, url);
      if (target === undefined || seen.has(target)) continue;
      for (const name of exportsOf(target, new Set([...seen, url]))) if (name !== 'default') names.add(name);
    }
    return names;
  };
  for (const [url, facts] of graph) {
    for (const entry of facts.imports) {
      const target = entry.dynamic ? undefined : resolve(entry.specifier, url);
      if (target === undefined || !graph.has(target)) continue;
      const available = exportsOf(target, new Set());
      for (const name of entry.names) {
        if (!available.has(name))
          problems.add(`${url} imports ${name} from ${entry.specifier}, which does not export it`);
      }
    }
  }
  return [...problems];
}
