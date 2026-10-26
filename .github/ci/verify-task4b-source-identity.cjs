const fs = require('fs');
const cp = require('child_process');
const ts = require('typescript');
const baseline = process.argv[2];
const current = cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const changed = cp.execFileSync('git', ['diff', '--name-only', baseline, current, '--', 'src'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const source = changed.filter(path => !/\.test\.tsx?$/.test(path));
const printer = ts.createPrinter({ removeComments: false });
const read = (revision, path) => cp.execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' });
const normalize = (path, text) => {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const imports = file.statements.filter(ts.isImportDeclaration).map(node => printer.printNode(ts.EmitHint.Unspecified, node, file)).sort();
  const body = printer.printFile(ts.factory.updateSourceFile(file, file.statements.filter(node => !ts.isImportDeclaration(node))));
  return JSON.stringify({ imports, body });
};
for (const path of source) {
  const before = read(baseline, path);
  const after = read(current, path);
  if (!/\.tsx?$/.test(path) ? before !== after : normalize(path, before) !== normalize(path, after)) {
    throw new Error(`Production source identity changed beyond import order: ${path}`);
  }
}
const receipt = { baseline, current, changed, productionChecked: source, result: 'production byte identity or normalized body plus exact import multiset identity' };
fs.writeFileSync('proof/source-identity.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
