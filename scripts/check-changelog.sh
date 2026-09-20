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
    # fail if the diff is empty
    if git diff --exit-code "origin/${BASE_REF}" -- "${CHANGELOG_FILE}"; then
        >&2 echo "Changes should come with an entry in the \"CHANGELOG.md\" file. This behavior
can be overridden by using the \"no changelog\" label, which is used for changes
that are trivial / explicitly stated not to require a changelog entry."
        exit 1
    fi

    echo "The \"CHANGELOG.md\" file has been updated."
fi
