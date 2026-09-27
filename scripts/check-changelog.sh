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
else
    # a changelog check is required
    # fail if the diff is empty. `git diff --quiet` exits 1 on a difference and 0 on none; any other
    # status is git failing (a missing base ref), which must not read as "the file changed". No
    # `set -e` here, so every status this gate depends on is checked by hand.
    git diff --quiet "origin/${BASE_REF}" -- "${CHANGELOG_FILE}"
    diff_status=$?
    if [ "${diff_status}" -eq 0 ]; then
        >&2 echo "Changes should come with an entry in the \"CHANGELOG.md\" file. This behavior
can be overridden by using the \"no changelog\" label, which is used for changes
that are trivial / explicitly stated not to require a changelog entry."
        exit 1
    elif [ "${diff_status}" -ne 1 ]; then
        >&2 echo "Could not diff ${CHANGELOG_FILE} against origin/${BASE_REF} (git exited ${diff_status})."
        exit 2
    fi

    echo "The \"CHANGELOG.md\" file has been updated."
fi

# Every added line must sit under a version newer than the latest release, judged per line by the
# heading that governs it (scripts/changelog-placement.sh). An entry filed under a published
# version edits notes that already shipped and goes missing from the next release. The latest
# release is the highest vX.Y.Z tag, not the newest `(TBD)` heading, which can outlive its release;
# release candidates do not close a version. The job checks out with fetch-depth: 0, so the tags
# are there.
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

if ! diff_text=$(git diff --no-ext-diff --no-color -U0 "origin/${BASE_REF}" -- "${CHANGELOG_FILE}"); then
    >&2 echo "Could not diff ${CHANGELOG_FILE} against origin/${BASE_REF}."
    exit 2
fi
# New-file line numbers of the added lines. With -U0 a hunk holds only removed and added lines, and
# only an added one advances the new-file count.
if ! added_lines=$(printf '%s\n' "${diff_text}" | awk '
    /^@@ / { in_hunk = 1; split($3, range, ","); line = substr(range[1], 2) + 0; next }
    !in_hunk { next }
    /^\+/ { print line; line++ }
'); then
    >&2 echo "Could not read the added lines from the diff of ${CHANGELOG_FILE}."
    exit 2
fi
if [ -z "${added_lines}" ]; then
    echo "No lines added to ${CHANGELOG_FILE}, so none to place."
    exit 0
fi

printf '%s\n' "${added_lines}" | bash "$(dirname "$0")/changelog-placement.sh" "${CHANGELOG_FILE}" "${latest_release}"
placement_status=$?
if [ "${placement_status}" -eq 1 ]; then
    >&2 echo
    >&2 echo "Entries belong under a version newer than the latest release, v${latest_release}: a"
    >&2 echo "\"## <version> (TBD)\" heading above it (add one if there is none). A deliberate"
    >&2 echo "correction to notes already published can take the \"no changelog\" label."
    exit 1
elif [ "${placement_status}" -ne 0 ]; then
    >&2 echo "The placement check could not run (exit ${placement_status})."
    exit 2
fi
echo "Every added line sits under a version newer than v${latest_release}."
