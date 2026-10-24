/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve(__dirname, '../../../.github/workflows/pr-e2e-bridge-guardian.yml'), 'utf8');

type Context = {
  'github.event_name': string;
  'github.repository': string;
  'github.event.pull_request.head.repo.full_name': string;
  'github.event.pull_request.base.ref': string;
  'github.actor': string;
};

const contexts = {
  'fork pull request': {
    'github.event_name': 'pull_request',
    'github.repository': 'miden/wallet',
    'github.event.pull_request.head.repo.full_name': 'contributor/wallet',
    'github.event.pull_request.base.ref': 'main',
    'github.actor': 'contributor'
  },
  'Dependabot pull request': {
    'github.event_name': 'pull_request',
    'github.repository': 'miden/wallet',
    'github.event.pull_request.head.repo.full_name': 'miden/wallet',
    'github.event.pull_request.base.ref': 'main',
    'github.actor': 'dependabot[bot]'
  },
  'trusted same-repository pull request': {
    'github.event_name': 'pull_request',
    'github.repository': 'miden/wallet',
    'github.event.pull_request.head.repo.full_name': 'miden/wallet',
    'github.event.pull_request.base.ref': 'main',
    'github.actor': 'wallet-maintainer'
  },
  'manual dispatch': {
    'github.event_name': 'workflow_dispatch',
    'github.repository': 'miden/wallet',
    'github.event.pull_request.head.repo.full_name': '',
    'github.event.pull_request.base.ref': '',
    'github.actor': 'wallet-maintainer'
  }
} satisfies Record<string, Context>;

const secretSteps = [
  'Validate dedicated OneClick Reown project',
  'Build extension for hermetic 1Click E2E',
  'Verify extension manifest for hermetic 1Click E2E',
  'Run hermetic 1Click E2E',
  'Require executed 1Click test cases'
];

function guardianJobBlock(): string {
  const lines = workflow.split('\n');
  const jobAt = lines.indexOf('  bridge-guardian-e2e:');
  if (jobAt < 0) throw new Error('bridge-guardian-e2e job is missing');
  const nextJobAt = lines.findIndex((line, index) => index > jobAt && /^  \S/.test(line));
  return lines.slice(jobAt, nextJobAt < 0 ? lines.length : nextJobAt).join('\n');
}

function stepBlocks(): Map<string, string> {
  const lines = guardianJobBlock().split('\n');
  const stepsAt = lines.indexOf('    steps:');
  if (stepsAt < 0) throw new Error('bridge-guardian job has no steps');
  const blocks = lines
    .slice(stepsAt + 1)
    .join('\n')
    .split(/\n(?=      - )/);
  return new Map(
    blocks.flatMap(block => {
      const name = /^      - name: (.+)$/m.exec(block)?.[1];
      return name === undefined ? [] : [[name, block]];
    })
  );
}

function conditionExpression(block: string): string {
  const conditions = block.match(/^        if:/gm) ?? [];
  if (conditions.length > 1) throw new Error('OneClick workflow step has duplicate if conditions');
  if (conditions.length === 0) return 'true';
  const condition = /^        if:\s*(.+)$/m.exec(block)?.[1] ?? '';
  if (!condition) throw new Error('OneClick workflow step has an empty if condition');
  return /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(condition)?.[1] ?? condition;
}

function guardianJobCondition(): string {
  const job = guardianJobBlock();
  const conditions = job.match(/^    if:/gm) ?? [];
  if (conditions.length !== 1) throw new Error('bridge-guardian job must have exactly one eligibility condition');
  const condition = /^    if:\s*(.+)$/m.exec(job)?.[1] ?? '';
  if (!condition) throw new Error('bridge-guardian job has an empty eligibility condition');
  return /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(condition)?.[1] ?? condition;
}

function evaluate(expression: string, context: Context): boolean {
  const tokens = expression.match(/\s*(?:&&|\|\||==|!=|!|\(|\)|'[^']*'|success\(\)|[a-zA-Z_][\w.]*)/g) ?? [];
  const source = expression.replace(/\s/g, '');
  if (tokens.join('').replace(/\s/g, '') !== source) throw new Error(`Unsupported workflow expression: ${expression}`);
  let cursor = 0;
  const take = (): string => {
    const token = tokens[cursor]?.trim();
    if (token === undefined) throw new Error(`Unexpected end of workflow expression: ${expression}`);
    cursor += 1;
    return token;
  };
  const peek = (): string | undefined => tokens[cursor]?.trim();
  const primary = (): string | boolean => {
    if (peek() === '(') {
      take();
      const value = or();
      if (take() !== ')') throw new Error(`Expected ')' in workflow expression: ${expression}`);
      return value;
    }
    const token = take();
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'success()') return true;
    if (token in context) return context[token as keyof Context];
    throw new Error(`Unsupported workflow context value: ${token}`);
  };
  const unary = (): string | boolean => (peek() === '!' ? (take(), !Boolean(unary())) : primary());
  const comparison = (): string | boolean => {
    const left = unary();
    const operator = peek();
    if (operator !== '==' && operator !== '!=') return left;
    take();
    const right = unary();
    return operator === '==' ? left === right : left !== right;
  };
  const and = (): string | boolean => {
    let value = comparison();
    while (peek() === '&&') {
      take();
      const right = comparison();
      value = Boolean(value) && Boolean(right);
    }
    return value;
  };
  const or = (): string | boolean => {
    let value = and();
    while (peek() === '||') {
      take();
      const right = and();
      value = Boolean(value) || Boolean(right);
    }
    return value;
  };
  const result = Boolean(or());
  if (cursor !== tokens.length) throw new Error(`Unexpected token in workflow expression: ${expression}`);
  return result;
}

function oneClickStepGates(context: Context): boolean[] {
  const blocks = stepBlocks();
  return secretSteps.map(name => {
    const block = blocks.get(name);
    if (block === undefined) throw new Error(`Missing required OneClick step: ${name}`);
    return evaluate(conditionExpression(block), context);
  });
}

describe('Guardian Bridge-Out OneClick secret workflow', () => {
  it('keeps ordinary Guardian coverage enabled for main pull requests and manual dispatch', () => {
    expect(workflow).toMatch(/^  pull_request:$/m);
    expect(workflow).toMatch(/^  workflow_dispatch: \{\}$/m);
    const guardian = stepBlocks().get('Run guardian bridge-out spec');
    expect(guardian).toBeDefined();
    expect(guardian).not.toMatch(/^        if:/m);
    for (const context of Object.values(contexts)) expect(evaluate(guardianJobCondition(), context)).toBe(true);
    expect(
      evaluate(guardianJobCondition(), {
        ...contexts['trusted same-repository pull request'],
        'github.event.pull_request.base.ref': 'next'
      })
    ).toBe(true);
  });

  it.each(Object.entries(contexts))('%s context has the expected OneClick event eligibility', (_label, context) => {
    const eligible =
      context['github.event_name'] === 'workflow_dispatch' ||
      (context['github.event.pull_request.head.repo.full_name'] === context['github.repository'] &&
        context['github.actor'] !== 'dependabot[bot]');
    expect(oneClickStepGates(context)).toEqual(secretSteps.map(() => eligible));
  });
});
