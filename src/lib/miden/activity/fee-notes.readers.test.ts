import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../..');
const SELF = 'src/lib/miden/activity/fee-notes.ts';

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const filesCalling = (call: string): string[] =>
  fs
    .readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .map(file => path.join('src', file))
    .filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && file !== SELF)
    .filter(file => read(file).includes(call))
    .sort();

// Past submit and outside any hold no lock sees a fee-check trap, and a landed row that fails offers a Retry that pays
// twice, so these readers alone answer one with the per-check answer and retire the client themselves; every other
// reader lets it through.
const LANDED_READERS = [
  'src/lib/miden/activity/fee.ts',
  'src/lib/miden/activity/helpers.ts',
  'src/lib/miden/transaction/complete.ts',
  'src/lib/miden/transaction/helper.ts',
  'src/lib/miden/transaction/landed-completion-reads.ts'
];

it.each(LANDED_READERS)('%s reads the fee split past submit through splitLandedOutputNotes only', file => {
  const source = read(file);
  expect(source).toMatch(/splitLandedOutputNotes\(/);
  expect(source).not.toMatch(/splitExecutedOutputNotes\(/);
});

it('no other module takes the landed split', () => {
  // Every non-test .ts/.tsx under src except fee-notes.ts itself, sorted.
  expect(filesCalling('splitLandedOutputNotes(')).toEqual(LANDED_READERS);
});

// Which argument names the landing: every landed read retires under the wallet row id.
const LANDING_ARGUMENT: Record<string, number> = {
  splitLandedOutputNotes: 1,
  feePaidFromResult: 1,
  feeFieldsFromResult: 1,
  readConsumeResult: 1,
  extractFullNote: 1,
  retireLandedTrap: 1,
  retiringLandedTraps: 0
};
// The fewest calls each file makes, so a scan that matched nothing fails.
const MIN_CALLS: Record<string, number> = {
  'src/lib/miden/activity/fee-notes.ts': 1,
  'src/lib/miden/activity/fee.ts': 2,
  'src/lib/miden/activity/helpers.ts': 1,
  'src/lib/miden/transaction/complete.ts': 11,
  'src/lib/miden/transaction/helper.ts': 2,
  'src/lib/miden/transaction/index.ts': 3,
  'src/lib/miden/transaction/landed-completion-reads.ts': 15
};

// A row object's id, or an id the enclosing function was handed. The chain's transaction id never names the row.
const ROW_OBJECTS = ['tx', 'transaction'];
const ROW_IDS = ['id', 'landing', 'transactionId'];

type LandedCall = { name: string; line: number; argument: string; namesRow: boolean };

const isParameterOfEnclosingFunction = (node: ts.Node, name: string): boolean => {
  for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === name)) {
      return true;
    }
  }
  return false;
};

const namesRow = (argument: ts.Expression | undefined): boolean => {
  if (argument === undefined) return false;
  if (ts.isPropertyAccessExpression(argument)) {
    const owner = argument.expression;
    return (
      argument.name.text === 'id' &&
      ts.isIdentifier(owner) &&
      ROW_OBJECTS.includes(owner.text) &&
      isParameterOfEnclosingFunction(argument, owner.text)
    );
  }
  return (
    ts.isIdentifier(argument) &&
    ROW_IDS.includes(argument.text) &&
    isParameterOfEnclosingFunction(argument, argument.text)
  );
};

// Declarations are not calls and comments are not nodes, so neither is collected; a call Prettier wraps is one node.
const landedCalls = (fileName: string, source: string): LandedCall[] => {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: LandedCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const index = Object.prototype.hasOwnProperty.call(LANDING_ARGUMENT, name) ? LANDING_ARGUMENT[name] : undefined;
      if (index !== undefined) {
        const argument = node.arguments[index];
        calls.push({
          name,
          line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
          argument: argument?.getText(tree) ?? '(missing)',
          namesRow: namesRow(argument)
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return calls;
};

it.each(Object.keys(MIN_CALLS))('%s names the wallet row in every landed read', file => {
  const calls = landedCalls(file, read(file));
  const minimum = MIN_CALLS[file];
  if (minimum === undefined) throw new Error(`no landed-call floor for ${file}`);
  expect(calls.length).toBeGreaterThanOrEqual(minimum);
  expect(calls.filter(call => !call.namesRow)).toEqual([]);
});

it('reads a landed call that spans several lines, and refuses the chain transaction id', () => {
  const wrapped = (landing: string) =>
    `const f = (tx: T) =>\n  feeFieldsFromResult(\n    result,\n    ${landing}\n  );\n`;
  expect(landedCalls('chain.ts', wrapped('executedTx.id().toHex()'))).toEqual([
    { name: 'feeFieldsFromResult', line: 2, argument: 'executedTx.id().toHex()', namesRow: false }
  ]);
  expect(landedCalls('row.ts', wrapped('tx.id'))).toEqual([
    { name: 'feeFieldsFromResult', line: 2, argument: 'tx.id', namesRow: true }
  ]);
});
