#!/bin/bash
set -uo pipefail

CHANGELOG_FILE="${1:-CHANGELOG.md}"
scripts_dir=$(dirname "$0")

# Every heading and section is read through scripts/changelog-sections.awk, the definition the release
# notes use too (scripts/changelog-notes.sh), so a line is judged where it would be published. The
# labelled files go to a temporary directory, never through $(...), which would drop trailing blank
# lines. Exit 0: the change passes. Exit 1: a rule failed. Exit 2: the gate could not judge.
work=$(mktemp -d) || exit 2
trap 'rm -rf "${work}"' EXIT

if ! awk -f "${scripts_dir}/changelog-sections.awk" "${CHANGELOG_FILE}" > "${work}/head"; then
    >&2 echo "Could not read the sections of ${CHANGELOG_FILE}."
    exit 2
fi

# CHANGELOG.md is union-merged (see .gitattributes) so parallel PRs adding an entry under the same
# heading do not conflict. Union keeps BOTH sides, and its one failure mode is duplication: if two PRs
# each open their own section for a version, the merge yields two headings with that version, and
# release-notes.yml publishes only the first. Nothing else would notice, so check it here, by version:
# `## 1.16.3 (TBD)` and `## 1.16.3 (2026-09-30)` are duplicates too.
#
# Runs before the "no changelog" escape hatch on purpose: a malformed file is a problem whether or
# not THIS PR was required to add an entry.
if ! duplicate_versions=$(awk -F '\t' '$3 == "heading" && $2 != "" { print $2 }' "${work}/head" | sort | uniq -d); then
    >&2 echo "Could not list the version headings of ${CHANGELOG_FILE}."
    exit 2
fi
if [ -n "${duplicate_versions}" ]; then
    >&2 echo "Duplicate version heading(s) in ${CHANGELOG_FILE}:"
    >&2 echo "${duplicate_versions}"
    >&2 echo
    >&2 echo "This usually means a union merge combined two PRs that each opened the same"
    >&2 echo "version section. Keep one heading and put both sets of entries under it."
    exit 1
fi

if [ "${NO_CHANGELOG_LABEL}" = "true" ]; then
    # 'no changelog' set, so finish successfully
    echo "\"no changelog\" label has been set"
    exit 0
fi

# The pull request's change is the working file against the merge base, not the base branch's tip: a
# re-run replays the old merge commit after the base has moved on, and the base's own edits since
# then are not this pull request's. The path is relative to the repository root, where CI runs this.
if ! base_commit=$(git merge-base "origin/${BASE_REF}" HEAD); then
    >&2 echo "Could not find where HEAD branched from origin/${BASE_REF}."
    exit 2
fi
if ! git show "${base_commit}:${CHANGELOG_FILE}" > "${work}/base.md"; then
    >&2 echo "Could not read ${CHANGELOG_FILE} at the merge base ${base_commit}."
    exit 2
fi
if ! awk -f "${scripts_dir}/changelog-sections.awk" "${work}/base.md" > "${work}/base"; then
    >&2 echo "Could not read the sections of ${CHANGELOG_FILE} at the merge base."
    exit 2
fi

# The latest release is the highest vX.Y.Z tag, not the newest `(TBD)` heading, which can outlive its
# release; release candidates do not close a version. The job checks out with fetch-depth: 0, so the
# tags are there.
if ! tags=$(git tag --list 'v*'); then
    >&2 echo "Could not list the release tags."
    exit 2
fi
latest_release=$(printf '%s\n' "${tags}" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
if [ -z "${latest_release}" ]; then
    >&2 echo "No release tag (vX.Y.Z) to compare ${CHANGELOG_FILE} against. The check needs the"
    >&2 echo "repository's tags: check out with fetch-depth: 0."
    exit 2
fi

# Each labelled line carries its text, so equal labels are an unchanged file; a change to the final
# newline alone changes no line.
if cmp -s "${work}/base" "${work}/head"; then
    >&2 echo "Changes should come with an entry in the \"CHANGELOG.md\" file. This behavior
can be overridden by using the \"no changelog\" label, which is used for changes
that are trivial / explicitly stated not to require a changelog entry."
    exit 1
fi
echo "The \"CHANGELOG.md\" file has been updated."

# Placement. Every non-blank line other than a heading or a --- line belongs to a group: the version
# of the section it is in, or the preamble, or "outside" (after a --- line). A text is added to a
# group when the working file has more copies of it there than the merge base; each copy beyond the
# base's count, in file order, is judged. An added line fails under a released version (an entry
# there edits notes that already shipped and misses the next release) and under a heading with no
# X.Y.Z version (the release notes match a full version, so it would never be published); an added
# entry fails in the preamble or outside every section, where prose is fine. An entry that leaves a
# released version and appears under another fails too: that is what a renamed, inserted or deleted
# heading, or a cut and paste, does to a published entry.
awk -F '\t' -v latest="${latest_release}" -v file="${CHANGELOG_FILE}" -v basefile="${work}/base" '
    function text() { return substr($0, length($1) + length($2) + length($3) + 4) }
    function xyz(v) { return v ~ /^[0-9]+\.[0-9]+\.[0-9]+$/ }
    function released(v,    a, b, i) {
        if (!xyz(v)) return 0
        split(v, a, ".")
        split(latest, b, ".")
        for (i = 1; i <= 3; i++) if (a[i] + 0 != b[i] + 0) return a[i] + 0 < b[i] + 0
        return 1
    }
    function entry(t) { return t ~ /^[ \t]*[-*+] / }
    function report(i, reason) {
        printf "%s:%d: %s: %s\n", file, hline[i], reason, htext[i]
        bad = 1
    }
    $3 == "heading" || $3 == "separator" { next }
    { t = text() }
    t ~ /^[ \t]*$/ { next }
    { g = ($3 == "section") ? "v" $2 : $3 }
    FILENAME == basefile { base[g, t]++; next }
    { n++; hline[n] = $1; hgroup[n] = g; htext[n] = t; head[g, t]++ }
    END {
        # Copies of each entry that left released versions: base count minus working count, per
        # released version, where positive. An entry gained elsewhere while one left moved out.
        for (k in base) {
            split(k, key, SUBSEP)
            if (key[1] !~ /^v/ || !released(substr(key[1], 2)) || !entry(key[2])) continue
            d = base[k] - ((k in head) ? head[k] : 0)
            if (d > 0) { left[key[2]] += d; from[key[2]] = substr(key[1], 2) }
        }
        for (i = 1; i <= n; i++) {
            g = hgroup[i]
            t = htext[i]
            if (++seen[g, t] <= base[g, t] + 0) continue
            v = substr(g, 2)
            if (g ~ /^v/ && released(v)) report(i, "under " v ", which is not newer than the latest release, " latest)
            else if (g ~ /^v/ && !xyz(v)) report(i, "under a heading with no X.Y.Z version (\"" v "\")")
            else if (g !~ /^v/ && entry(t)) report(i, "an entry outside every version section")
            else if (entry(t) && left[t] > 0) { report(i, "a released entry moved out of " from[t] ", which is already released"); left[t]-- }
        }
        exit bad ? 1 : 0
    }
' "${work}/base" "${work}/head"
placement_status=$?
if [ "${placement_status}" -eq 1 ]; then
    >&2 echo
    >&2 echo "Entries belong under a \"## <version> (TBD)\" heading whose version is newer than the latest"
    >&2 echo "release, v${latest_release} (open one at the top if there is none). A released heading is never"
    >&2 echo "renamed, moved or deleted. A deliberate correction to notes already published can take the"
    >&2 echo "\"no changelog\" label."
    exit 1
elif [ "${placement_status}" -ne 0 ]; then
    >&2 echo "The placement check could not run (exit ${placement_status})."
    exit 2
fi
echo "Every change sits under a version newer than v${latest_release}."
