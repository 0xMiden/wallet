import { readFileSync } from 'node:fs';

const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const finished = result.numPassedTestSuites + result.numFailedTestSuites + result.numPendingTestSuites;
if (result.wasInterrupted !== false || finished !== result.numTotalTestSuites || finished === 0) {
  throw new Error(`Incomplete Jest run: ${finished} of ${result.numTotalTestSuites} suites accounted for`);
}
