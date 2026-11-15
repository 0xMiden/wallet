/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// A tag such as `actions/checkout@v4` can be moved to other code after review, and every job that names it runs that
// code with the job's token and secrets. A commit SHA cannot move, so every third-party action and reusable workflow is
// pinned to one, with the tag it was taken from in a comment for Dependabot and for readers.
const ROOT = resolve(__dirname, '../../..');

/** A step's or job's `uses:` value and its trailing comment; a comment line or a run script never starts this way. */
const USES = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/;
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const PINNED_IMAGE = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

const yamlFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(entry.name) ? [path] : [];
  });

/** Each `uses:` line in `text` that names a third-party ref without a commit SHA and its tag comment. */
const unpinnedUses = (file: string, text: string): string[] =>
  text.split('\n').flatMap((line, index) => {
    const match = USES.exec(line);
    if (match === null) return [];
    const [, ref = '', comment] = match;
    if (ref.startsWith('./')) return [];
    const pinned = ref.startsWith('docker://') ? PINNED_IMAGE.test(ref) : PINNED_ACTION.test(ref);
    return pinned && comment !== undefined && /^#\s*\S/.test(comment) ? [] : [`${file}:${index + 1}: ${line.trim()}`];
  });

describe('GitHub Actions refs', () => {
  const files = yamlFiles(join(ROOT, '.github')).map(path => ({
    name: relative(ROOT, path),
    text: readFileSync(path, 'utf8')
  }));

  it('pins every third-party action and reusable workflow to a commit SHA, with its tag in a comment', () => {
    const thirdParty = files.flatMap(({ text }) =>
      text.split('\n').filter(line => USES.test(line) && !/uses:\s*['"]?\.\//.test(line))
    );
    expect(thirdParty.length).toBeGreaterThan(100);
    expect(files.flatMap(({ name, text }) => unpinnedUses(name, text))).toEqual([]);
  });

  it.each([
    ['      - uses: actions/checkout@v4', 1],
    ['        uses: actions/checkout@main', 1],
    ["      - uses: 'actions/cache/restore@v4'", 1],
    ['      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 1],
    ['      - uses: actions/checkout@11d5960 # v4', 1],
    ['    uses: some-org/some-repo/.github/workflows/build.yml@main', 1],
    ['      - uses: docker://alpine:3.20 # 3.20', 1],
    ['      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4', 0],
    ['        uses: gradle/actions/setup-gradle@ed408507eac070d1f99cc633dbcf757c94c7933a # v4', 0],
    ['      - uses: ./.github/actions/yarn-install', 0],
    ['      # uses: actions/checkout@v4', 0]
  ])('reads %j as %i unpinned ref', (line, count) => {
    expect(unpinnedUses('x.yml', `    steps:\n${line}\n`)).toHaveLength(count);
  });
});
