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

# Every line this PR adds must sit inside the UNRELEASED `## <version> (TBD)` section. Matching the
# neighbouring bullets is not enough: an entry appended next to an already-published section's
# entries reads as correct in the diff, retroactively edits shipped release notes, and is missing
# from the next release's. That has happened twice, so check it rather than trusting the author's
# eye. Only the FIRST (TBD) heading is current - older sections kept a stale (TBD) of their own,
# so the window is that heading up to the next `## ` heading below it.
tbd_start=$(grep -nE '^## .*\(TBD\)' "${CHANGELOG_FILE}" | head -1 | cut -d: -f1)
if [ -n "${tbd_start}" ]; then
    tbd_end=$(awk -v s="${tbd_start}" 'NR>s && /^## /{print NR; exit}' "${CHANGELOG_FILE}")
    [ -z "${tbd_end}" ] && tbd_end=$(wc -l < "${CHANGELOG_FILE}")
    # `+start,count` with count 0 is a pure deletion hunk and adds nothing, so it is not a
    # placement claim; a bare `+start` means one added line.
    misfiled=$(git diff --unified=0 "origin/${BASE_REF}" -- "${CHANGELOG_FILE}" \
        | grep -E '^@@' \
        | sed -E 's/^@@ [^+]*\+([0-9]+)(,([0-9]+))?.*/\1 \3/' \
        | awk -v s="${tbd_start}" -v e="${tbd_end}" \
              '{ n = ($2 == "" ? 1 : $2) } n > 0 && ($1 <= s || $1 >= e) { print $1 }')
    if [ -n "${misfiled}" ]; then
        >&2 echo "New ${CHANGELOG_FILE} lines were added outside the current \"(TBD)\" section"
        >&2 echo "(lines ${tbd_start}-${tbd_end}), i.e. under an already-published version."
        >&2 echo "Added at line(s): ${misfiled}"
        >&2 echo
        >&2 echo "Move the entry under the \"## <version> (TBD)\" heading instead."
        exit 1
    fi
fi

if [ "${NO_CHANGELOG_LABEL}" = "true" ]; then
    # 'no changelog' set, so finish successfully
    echo "\"no changelog\" label has been set"
    exit 0
else
    # a changelog check is required
    # fail if the diff is empty
    if git diff --exit-code "origin/${BASE_REF}" -- "${CHANGELOG_FILE}"; then
        >&2 echo "Changes should come with an entry in the \"CHANGELOG.md\" file. This behavior
can be overridden by using the \"no changelog\" label, which is used for changes
that are trivial / explicitly stated not to require a changelog entry."
        exit 1
    fi

    echo "The \"CHANGELOG.md\" file has been updated."
fi
