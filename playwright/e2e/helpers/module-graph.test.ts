/**
 * @jest-environment node
 */
import { exportedNames, importedSpecifiers, linkProblems } from './module-graph';

// A path the server does not hold answers 404, as the real one does.
function serverOf(files: Record<string, string>, imports: Record<string, string> = {}) {
  return {
    importMap: { imports },
    serve: (url: string) => {
      const body = files[url];
      return body === undefined
        ? { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`no ${url}`) }
        : { status: 200, contentType: 'text/javascript; charset=utf-8', body: Buffer.from(body) };
    }
  };
}

describe('linkProblems', () => {
  it('passes a graph whose every import resolves and is exported, through export * and relative paths', () => {
    const server = serverOf(
      {
        '/page.js': "import { a, b } from 'dep'; import d from './sub/d.js'; export const page = a + b + d;",
        '/dep/index.js': "export * from './more.js'; export const a = 1;",
        '/dep/more.js': 'export const b = 2;',
        '/sub/d.js': 'export default 3;'
      },
      { dep: '/dep/index.js' }
    );
    expect(linkProblems(server, ['/page.js'])).toEqual([]);
  });

  it('names a named or default import its target does not export', () => {
    const server = serverOf({
      '/page.js': "import x, { missing } from '/dep.js';",
      '/dep.js': 'export const kept = 1;'
    });
    expect(linkProblems(server, ['/page.js']).sort()).toEqual([
      '/page.js imports default from /dep.js, which does not export it',
      '/page.js imports missing from /dep.js, which does not export it'
    ]);
  });

  it('names an unmapped bare specifier, a dynamic import among them, and a module the server does not serve', () => {
    const server = serverOf({
      '/page.js': "import '/gone.js'; import 'unmapped'; export const later = () => import('lazy');"
    });
    expect(linkProblems(server, ['/page.js']).sort()).toEqual([
      '/gone.js answers 404: no /gone.js',
      '/page.js imports lazy, which the import map lacks',
      '/page.js imports unmapped, which the import map lacks'
    ]);
  });
});

describe('exportedNames and importedSpecifiers', () => {
  it('read destructured, declared and default exports, and static imports in source order', () => {
    const source =
      "import '/a.js'; import b from '/b.js'; export const { x, y } = b; export function f() {} export default b;" +
      " export const later = () => import('/c.js');";
    expect(exportedNames(source)).toEqual(['default', 'f', 'later', 'x', 'y']);
    expect(importedSpecifiers(source)).toEqual(['/a.js', '/b.js']);
  });
});
