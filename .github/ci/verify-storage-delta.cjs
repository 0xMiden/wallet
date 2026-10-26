const fs = require('fs');
const cp = require('child_process');
const crypto = require('crypto');
const [base, path, beforeHash, afterHash] = process.argv.slice(2);
const read = (revision, name) => cp.execFileSync('git', ['show', `${revision}:${name}`]);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const current = cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const changed = cp.execFileSync('git', ['diff', '--name-only', base, current, '--', 'src'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
if (changed.length !== 1 || changed[0] !== path || hash(read(base, path)) !== beforeHash || hash(fs.readFileSync(path)) !== afterHash) {
  throw new Error('Source identity differs from the exact allowed correction');
}
const result = { base, current, changed, beforeHash, afterHash, otherSourcePaths: 'byte-identical', result: 'exact allowed stage-decline correction only' };
fs.writeFileSync('proof/source-identity.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
