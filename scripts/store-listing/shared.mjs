import path from 'node:path';

/**
 * Helpers shared by the three store-listing CLIs.
 *
 * They live here because the alternative was three copies, and the copy that went missing was
 * the one that mattered: `compose-copy.mjs` resolved its output directory from a manifest-supplied
 * slug with no containment check, while its two siblings each carried their own `resolveInside`.
 * A guard present in two of three places is a coincidence, not a guard.
 */

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Resolve `relativePath` under `root` and refuse anything that escapes it.
 *
 * Publication inputs and outputs must remain reviewable repository files. A manifest path outside
 * the root could make a build read private state, or write over files the package does not own.
 */
export function resolveInside(root, relativePath, label) {
  assert(typeof relativePath === 'string' && relativePath.length > 0, `${label} path is required`);
  const resolved = path.resolve(root, relativePath);
  const relation = path.relative(root, resolved);
  assert(
    relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation),
    `${label} escapes root`
  );
  return resolved;
}

/**
 * Every string reachable from `value`, at any depth.
 *
 * Recursive scanning covers later schema additions automatically: a new text field cannot bypass
 * the forbidden-claim or punctuation checks by being added somewhere the walker did not know about.
 */
export function allStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(allStrings);
  return [];
}
