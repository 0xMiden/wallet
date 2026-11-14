/** @jest-environment node */

import { readFileSync } from 'fs';
import { join } from 'path';

type SyntaxRule = ['error', ...{ selector: string; message: string }[]];
interface RuleTester {
  verify(
    code: string,
    config: {
      parserOptions: { ecmaVersion: number; sourceType: string; ecmaFeatures: { jsx: boolean } };
      rules: { 'no-restricted-syntax': SyntaxRule };
    }
  ): { ruleId: string | null; message: string }[];
}
const { Linter } = jest.requireActual<{ Linter: new () => RuleTester }>('eslint');

const config: {
  overrides: { files: string[]; rules: Record<string, SyntaxRule> }[];
} = JSON.parse(readFileSync(join(__dirname, '../../../.eslintrc'), 'utf8'));
const rule = config.overrides.find(entry => entry.files.includes('src/**/*.tsx'))?.rules['no-restricted-syntax'];
if (!rule) throw new Error('Missing amount display lint policy');
const linter = new Linter();

function policyErrors(code: string) {
  return linter.verify(code, {
    parserOptions: { ecmaVersion: 2020, sourceType: 'module', ecmaFeatures: { jsx: true } },
    rules: { 'no-restricted-syntax': rule ?? ['error'] }
  });
}

describe('amount display lint policy', () => {
  it.each(['toAdaptiveFixed', 'adaptiveFormatterFor', 'getAdaptiveDecimalPlaces', 'formatUsd', 'usdFormatterFor'])(
    'rejects the old %s presentation helper, including aliases',
    helper => {
      const errors = policyErrors(`import { ${helper} as display } from 'lib/i18n/numbers';`);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('TokenAmount');
    }
  );

  it.each(['formatUnits', 'formatBigInt'])('rejects %s inside JSX', helper => {
    const errors = policyErrors(`const Amount = () => <span>{${helper}(1n, 18)}</span>;`);
    expect(errors).toHaveLength(1);
  });

  it('permits the shared components and exact transaction conversions', () => {
    const errors = policyErrors(`
      import { TokenAmount } from 'components/ui/TokenAmount';
      const transactionInput = formatUnits(1n, 18);
      const Amount = () => <TokenAmount amount={1n} decimals={18} rounding="down" />;
    `);
    expect(errors).toHaveLength(0);
  });

  it('retains the output-note restriction', () => {
    const errors = policyErrors('const notes = transaction.outputNotes();');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('splitExecutedOutputNotes');
  });
});
