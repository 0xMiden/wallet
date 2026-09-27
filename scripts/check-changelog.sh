#!/bin/bash
set -uo pipefail

CHANGELOG_FILE="${1:-CHANGELOG.md}"

# CHANGELOG.md is union-merged (see .gitattributes) so parallel PRs adding an
# entry under the same heading no longer conflict. Union keeps BOTH sides, and
# its one failure mode is duplication: if two PRs each OPEN their own
# `## <version> (TBD)` section, the merge yields two identical headings — and
# release-notes.yml extracts by matching the first one, so it would publish the
# wrong (likely empty) section. Nothing else would notice, so check it here.
#
# Runs before the "no changelog" escape hatch on purpose: a malformed file is a
# problem whether or not THIS PR was required to add an entry.
duplicate_headings=$(grep -E '^## ' "${CHANGELOG_FILE}" | sort | uniq -d)
if [ -n "${duplicate_headings}" ]; then
    >&2 echo "Duplicate version heading(s) in ${CHANGELOG_FILE}:"
    >&2 echo "${duplicate_headings}"
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

# A changelog check is required. One diff serves both checks below. There is no `set -e`, so every
# status this gate depends on is checked by hand. `--inter-hunk-context=0` keeps a user's
# diff.interHunkContext from fusing hunks, which would put context lines among the changed ones.
if ! diff_text=$(git diff --no-ext-diff --no-color --inter-hunk-context=0 -U0 "origin/${BASE_REF}" -- "${CHANGELOG_FILE}"); then
    >&2 echo "Could not diff ${CHANGELOG_FILE} against origin/${BASE_REF}."
    exit 2
fi
if [ -z "${diff_text}" ]; then
    >&2 echo "Changes should come with an entry in the \"CHANGELOG.md\" file. This behavior
can be overridden by using the \"no changelog\" label, which is used for changes
that are trivial / explicitly stated not to require a changelog entry."
    exit 1
fi
echo "The \"CHANGELOG.md\" file has been updated."

# Where each changed line may sit. release-notes.yml publishes a version's notes from its own
# section, so a line filed under a released version edits notes that already shipped and is missing
# from the next release. Two rules: a line the pull request adds, or an unchanged line whose section
# it changes, must sit under a version newer than the latest release (or in the preamble, as prose);
# and a line that sat under a released version stays under it. The latest release is the highest
# vX.Y.Z tag, not the newest `(TBD)` heading, which can outlive its release; release candidates do
# not close a version. The job checks out with fetch-depth: 0, so the tags are there.
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

if ! work=$(mktemp -d); then
    >&2 echo "Could not create a working directory."
    exit 2
fi
trap 'rm -rf "${work:?}"' EXIT
if ! printf '%s\n' "${diff_text}" > "${work}/diff" || ! git show "origin/${BASE_REF}:./${CHANGELOG_FILE}" > "${work}/base"; then
    >&2 echo "Could not read ${CHANGELOG_FILE} as it is on origin/${BASE_REF}."
    exit 2
fi

# The diff marks which head lines were added and which base lines removed. Walking head and base
# in step, skipping those, pairs every other head line with its base line; a pair that differs, or
# two files that do not run out together, means the diff was misread, so the check fails closed.
awk -v latest="${latest_release}" -v diff_file="${work}/diff" -v base_file="${work}/base" -v file="${CHANGELOG_FILE}" '
    function version_of(line,    words) { split(substr(line, 4), words, " "); return words[1] }
    function xyz(v) { return v ~ /^[0-9]+\.[0-9]+\.[0-9]+$/ }
    function newer(v,    a, b, k) {
        split(v, a, ".")
        split(latest, b, ".")
        for (k = 1; k <= 3; k++) if (a[k] + 0 != b[k] + 0) return a[k] + 0 > b[k] + 0
        return 0
    }
    function report(n, reason) {
        printf "%s:%d: %s: %s\n", file, n, reason, head[n]
        bad = 1
    }
    # A line the pull request put where it is: an added line, or one whose section it changed.
    function judge(n, v, prefix) {
        if (v == "") {
            if (head[n] ~ /^[ \t]*[-*+] /) report(n, prefix "an entry above every version heading")
        } else if (!xyz(v)) {
            report(n, prefix "under \"" v "\", which is not an X.Y.Z version")
        } else if (!newer(v)) {
            report(n, prefix "under " v ", which is not newer than the latest release, " latest)
        }
    }
    function skip(line) { return line ~ /^## / || line ~ /^[ \t]*$/ }
    FILENAME == diff_file {
        if ($0 ~ /^@@ /) {
            split($2, old, ",")
            split($3, new, ",")
            b = substr(old[1], 2) + 0
            h = substr(new[1], 2) + 0
            in_hunk = 1
        } else if (in_hunk && $0 ~ /^-/) {
            removed[b++] = 1
        } else if (in_hunk && $0 ~ /^\+/) {
            added[h++] = 1
        } else if (in_hunk && $0 ~ /^ /) {
            b++
            h++
        }
        next
    }
    FILENAME == base_file {
        if ($0 ~ /^## /) base_version = version_of($0)
        base[FNR] = $0
        bver[FNR] = base_version
        nb = FNR
        next
    }
    {
        if ($0 ~ /^## /) head_version = version_of($0)
        head[FNR] = $0
        hver[FNR] = head_version
        nh = FNR
    }
    END {
        i = 1
        j = 1
        while (i <= nh || j <= nb) {
            if (i <= nh && (i in added)) {
                if (!skip(head[i])) judge(i, hver[i], "")
                i++
            } else if (j <= nb && (j in removed)) {
                j++
            } else if (i > nh || j > nb || head[i] != base[j]) {
                printf "%s: could not pair line %d with line %d of the base copy\n", file, i, j
                exit 3
            } else {
                if (!skip(head[i]) && hver[i] != bver[j]) {
                    if (xyz(bver[j]) && !newer(bver[j])) {
                        report(i, "moved from released " bver[j] " to " (hver[i] == "" ? "above every version heading" : hver[i]))
                    } else {
                        judge(i, hver[i], "moved from " (bver[j] == "" ? "the preamble" : bver[j]) " and now ")
                    }
                }
                i++
                j++
            }
        }
        exit bad ? 1 : 0
    }
' "${work}/diff" "${work}/base" "${CHANGELOG_FILE}"
placement_status=$?
if [ "${placement_status}" -eq 1 ]; then
    >&2 echo
    >&2 echo "The latest release is v${latest_release}. A new entry goes under a \"## <version> (TBD)\""
    >&2 echo "heading newer than it (open one at the top if there is none), and a line already under a"
    >&2 echo "released version stays there: do not rename a released heading or put a new one above its"
    >&2 echo "entries. A deliberate correction to notes already published can take the \"no changelog\" label."
    exit 1
elif [ "${placement_status}" -ne 0 ]; then
    >&2 echo "The placement check could not run (awk exited ${placement_status})."
    exit 2
fi
echo "Every changed line sits under a version newer than v${latest_release}, and no released line moved."
