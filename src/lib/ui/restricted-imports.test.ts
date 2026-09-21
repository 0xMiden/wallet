/**
 * @jest-environment node
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Runs the repo's real ESLint config (.eslintrc) over an in-memory file, so this
// proves the design-system import bans fire where they should and stay quiet
// where they should not: a new importer of a retired module fails lint, the
// canonical replacement passes, and the allow-listed atoms importers keep only
// the atoms exemption.
//
// WHICH HALF PROVES WHAT, because the two are easy to confuse:
//   - `REPLACEMENTS` is hand-written and is the independent oracle. It is NOT read from .eslintrc
//     at run time, so editing a ban's message there turns this red.
//   - the ENUMERATION is derived from .eslintrc, so a group added, renamed, typo'd or deleted
//     breaks the key-set equality below.
// Deriving the expectation as well as the enumeration would make the test self-consistent and
// therefore unfalsifiable: a typo in a group's specifier would also move the fixture that imports
// it, and the test would stay green. Keep these two halves on opposite sides.

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

/**
 * The replacement each retired module points at. Hand-written on purpose: this is what makes the
 * test able to fail. Adding a ban to .eslintrc without adding it here fails the key-set assertion.
 */
const REPLACEMENTS: Record<string, string> = {
  'lib/ui/button': 'components/ui/Button',
  'lib/ui/badge': 'components/ui/Pill',
  'lib/ui/skeleton': 'components/ui/Skeleton',
  'lib/ui/DetailCard': 'components/ui/DetailCard',
  'components/EmptyState': 'components/ui/EmptyState',
  'components/flow/FlowDetails': 'components/ui/DetailCard',
  'components/NavigationHeader': 'components/PageHeader',
  'components/ScreenHeader': 'components/PageHeader',
  'components/CircleButton': 'components/ui/IconButton',
  'components/NavButton': 'components/ui/IconButton',
  'components/CardItem': 'components/ui/ListRow',
  'components/ListItem': 'components/ui/ListRow',
  'app/templates/MenuItem': 'components/ui/ListRow',
  'components/Chip': 'components/ui/Pill',
  'components/TextArea': 'components/ui/TextField',
  'components/review/ReviewRow': 'components/ui/DetailCard',
  'components/review/ReviewAmount': 'components/ui/Hero',
  'app/templates/history/DetailCard': 'components/ui/DetailCard',
  'app/templates/ConfirmationModal': 'useConfirm',
  'app/templates/AlertModal': 'useAlert',
  'app/templates/ModalWithTitle': 'lib/ui/drawer',
  'app/templates/SearchField': 'components/ui/SearchInput',
  'app/templates/SearchAssetField': 'components/ui/SearchInput',
  'react-modal': 'lib/ui/drawer'
};

/** The one group whose entries are all globs, so it has no specifier to derive. */
const ATOMS_SPECIFIERS = ['app/atoms/Alert', '../atoms/FormField'];
const ATOMS_REPLACEMENT = 'components/ui';

type Group = { entries: string[]; message: string; ruleId: string };

/** Every `no-restricted-imports` pattern group the real config declares. */
function configGroups(): Group[] {
  const cfg: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, '.eslintrc'), 'utf8'));
  const groups: Group[] = [];
  const collect = (rules: Record<string, unknown> | undefined) => {
    for (const [ruleId, value] of Object.entries(rules ?? {})) {
      if (!ruleId.endsWith('no-restricted-imports')) continue;
      // A third entry sets this rule to the bare string "off" for the allow-listed files; an
      // index into a string would silently yield a character and then iterate undefined.
      if (!Array.isArray(value) || value.length < 2) continue;
      const options = value[1] as { patterns?: { group?: string[]; message?: string }[] };
      for (const g of options.patterns ?? []) {
        groups.push({ entries: g.group ?? [], message: g.message ?? '', ruleId });
      }
    }
  };
  const root = cfg as { rules?: Record<string, unknown>; overrides?: { rules?: Record<string, unknown> }[] };
  collect(root.rules);
  for (const override of root.overrides ?? []) collect(override.rules);
  return groups;
}

const GROUPS = configGroups();
const bareOf = (g: Group) => g.entries.find(e => !e.includes('*'));
const CONCRETE = GROUPS.filter(g => bareOf(g) !== undefined);
const GLOB_ONLY = GROUPS.filter(g => bareOf(g) === undefined);

// One import per LINE, and one line per pattern ENTRY rather than per group: every group carries a
// bare specifier plus its globbed twin, and importing only the bare form leaves the globbed arm -
// the one that catches a real relative importer - never exercised.
const source = (specifiers: string[]) => specifiers.map((s, i) => `import * as M${i} from '${s}';`).join('\n') + '\n';

const restrictionsByLine = (messages: Message[]) =>
  new Map(
    messages
      .filter(m => m.ruleId === 'no-restricted-imports' || m.ruleId === '@typescript-eslint/no-restricted-imports')
      .map(m => [m.line, m])
  );

const ALLOWED = ['components/ui/Button', 'components/Button', 'components/ui/EmptyState', 'components/ui/DetailCard'];

/** What each fixture line is meant to prove. */
type Case = { specifier: string; label: string; ruleId: string; replacement?: string };

const CASES: Case[] = [
  ...CONCRETE.flatMap((g): Case[] => {
    const bare = bareOf(g) as string;
    const rows: Case[] = [
      { specifier: bare, label: `${bare} (bare)`, ruleId: g.ruleId, replacement: REPLACEMENTS[bare] }
    ];
    // Only when the group actually carries a globbed arm - `react-modal` does not.
    if (g.entries.some(e => e.startsWith('**') && e.includes('/'))) {
      rows.push({
        specifier: `../../${bare}`,
        label: `${bare} (relative, proves the globbed arm)`,
        ruleId: g.ruleId,
        replacement: REPLACEMENTS[bare]
      });
    }
    return rows;
  }),
  ...ATOMS_SPECIFIERS.map(
    (s): Case => ({
      specifier: s,
      label: `${s} (atoms, glob-only group)`,
      ruleId: '@typescript-eslint/no-restricted-imports',
      replacement: ATOMS_REPLACEMENT
    })
  )
];

describe('design-system import bans', () => {
  // One fixture, one spawn: cost is ESLint startup, not line count.
  const specifiers = [...CASES.map(c => c.specifier), ...ALLOWED];
  let found = new Map<number, Message>();

  beforeAll(() => {
    found = restrictionsByLine(lint('src/app/pages/RestrictedImportsFixture.tsx', source(specifiers)));
  }, 60_000);

  const lineOf = (specifier: string) => specifiers.indexOf(specifier) + 1;

  it('knows about every ban the config declares', () => {
    // The enumeration is derived; the expectation is not. A group added, renamed, typo'd or deleted
    // in .eslintrc shows up here as a key-set difference.
    expect(new Set(CONCRETE.map(g => bareOf(g)))).toEqual(new Set(Object.keys(REPLACEMENTS)));
  });

  it('has a representative for the glob-only group, rather than silently skipping it', () => {
    // Exactly one group (the frozen-atoms ban) is all globs. Pinning the count means a future
    // glob-only group fails here instead of vanishing from the table.
    expect(GLOB_ONLY).toHaveLength(1);
    expect(GLOB_ONLY[0]?.ruleId).toBe('@typescript-eslint/no-restricted-imports');
  });

  it.each(CASES.map(c => [c.label, c] as const))('bans %s', (_label, c) => {
    expect(found.get(lineOf(c.specifier))?.ruleId).toBe(c.ruleId);
  });

  it.each(CASES.filter(c => c.replacement).map(c => [c.label, c] as const))(
    'points %s at its replacement',
    (_label, c) => {
      expect(found.get(lineOf(c.specifier))?.message).toContain(c.replacement);
    }
  );

  it.each(ALLOWED)('allows %s', specifier => {
    expect(found.get(lineOf(specifier))).toBeUndefined();
  });

  it('lets an allow-listed atoms importer keep its atoms imports but not the retired modules', () => {
    // Its own spawn because the assertion is about the FIXTURE PATH: this file is on the
    // .eslintrc disable list for the atoms rule, which is the whole point of the case.
    const onAllowListed = restrictionsByLine(
      lint('src/app/ConfirmPage.tsx', source(['app/atoms/Alert', 'lib/ui/button']))
    );

    expect(onAllowListed.get(1)).toBeUndefined();
    expect(onAllowListed.get(2)?.ruleId).toBe('no-restricted-imports');
  }, 60_000);
});
