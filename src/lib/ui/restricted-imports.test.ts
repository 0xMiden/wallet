/**
 * @jest-environment node
 */
import { spawnSync } from 'child_process';
import path from 'path';

// Runs the repo's real ESLint config (.eslintrc) over an in-memory file, so this
// proves the design-system import bans fire where they should and stay quiet
// where they should not: a new importer of a retired module fails lint, the
// canonical replacement passes, and the allow-listed atoms importers keep only
// the atoms exemption.

const ROOT = path.join(__dirname, '../../..');

type Message = { line: number; ruleId: string | null; message: string };

function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && 'line' in value && 'ruleId' in value && 'message' in value;
}

function lint(filePath: string, code: string): Message[] {
  const result = spawnSync(
    'npx',
    ['eslint', '--no-ignore', '--format', 'json', '--stdin', '--stdin-filename', filePath],
    { cwd: ROOT, input: code, encoding: 'utf8' }
  );
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`unexpected ESLint output: ${result.stderr}`);
  const report: unknown = parsed[0];
  if (typeof report !== 'object' || report === null || !('messages' in report) || !Array.isArray(report.messages)) {
    throw new Error('ESLint report has no messages');
  }
  return report.messages.filter(isMessage);
}

const BANNED = [
  'lib/ui/button',
  'lib/ui/badge',
  'components/EmptyState',
  'components/flow/FlowDetails',
  'components/NavigationHeader',
  'components/CircleButton',
  'components/NavButton',
  'react-modal'
];
const ALLOWED = ['components/ui/Button', 'components/Button', 'components/ui/EmptyState', 'components/ui/DetailCard'];
const ATOMS = ['app/atoms/Alert', '../atoms/FormField'];

/** One import per line, so a report's line number names the specifier it is about. */
const source = (specifiers: string[]) => specifiers.map((s, i) => `import * as M${i} from '${s}';`).join('\n') + '\n';

const restrictionsByLine = (messages: Message[]) =>
  new Map(
    messages
      .filter(m => m.ruleId === 'no-restricted-imports' || m.ruleId === '@typescript-eslint/no-restricted-imports')
      .map(m => [m.line, m])
  );

describe('design-system import bans', () => {
  const specifiers = [...BANNED, ...ALLOWED, ...ATOMS];
  let found = new Map<number, Message>();

  beforeAll(() => {
    found = restrictionsByLine(lint('src/app/pages/RestrictedImportsFixture.tsx', source(specifiers)));
  }, 60_000);

  const lineOf = (specifier: string) => specifiers.indexOf(specifier) + 1;

  it.each(BANNED)('bans %s', specifier => {
    expect(found.get(lineOf(specifier))?.ruleId).toBe('no-restricted-imports');
  });

  it.each(ATOMS)('bans a new importer of %s', specifier => {
    expect(found.get(lineOf(specifier))?.ruleId).toBe('@typescript-eslint/no-restricted-imports');
  });

  it.each(ALLOWED)('allows %s', specifier => {
    expect(found.get(lineOf(specifier))).toBeUndefined();
  });

  it('points each ban at its replacement', () => {
    const found = restrictionsByLine(lint('src/app/pages/RestrictedImportsFixture.tsx', source(BANNED)));

    expect(found.get(1)?.message).toContain('components/ui/Button');
    expect(found.get(2)?.message).toContain('components/ui/Pill');
    expect(found.get(3)?.message).toContain('components/ui/EmptyState');
    expect(found.get(4)?.message).toContain('components/ui/DetailCard');
    expect(found.get(5)?.message).toContain('components/PageHeader');
    expect(found.get(6)?.message).toContain('components/ui/IconButton');
    expect(found.get(7)?.message).toContain('components/ui/IconButton');
    expect(found.get(8)?.message).toContain('lib/ui/drawer');
  }, 60_000);

  it('lets an allow-listed atoms importer keep its atoms imports but not the retired modules', () => {
    const found = restrictionsByLine(lint('src/app/ConfirmPage.tsx', source(['app/atoms/Alert', 'lib/ui/button'])));

    expect(found.get(1)).toBeUndefined();
    expect(found.get(2)?.ruleId).toBe('no-restricted-imports');
  }, 60_000);
});
