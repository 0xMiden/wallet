import fs from 'fs';
import path from 'path';

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

// Past submit and outside any hold, `splitLandedOutputNotes` and `feePaidFromResult` answer a fee-check trap, retire
// the realm client once per wallet row id (`lib/miden/sdk/caught-trap-retirement`) and still record the landed row
// completed. These readers alone take that split; every other reader lets the trap through.
const LANDED_READERS = [
  'src/lib/miden/activity/helpers.ts',
  'src/lib/miden/transaction/complete.ts',
  'src/lib/miden/transaction/helper.ts'
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
