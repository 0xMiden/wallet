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

    # ...and it must be filed under the UNRELEASED section. Matching the neighbouring bullets is
    # not the check: an entry appended beside an already-published section's entries reads as
    # correct in the diff, retroactively edits shipped release notes, and is missing from the next
    # release's. That has happened twice.
    #
    # Judge each ADDED LINE by the heading that governs it, never by line arithmetic. `(TBD)` alone
    # is not enough - older published sections kept a stale `(TBD)` of their own - so the governing
    # heading must be `(TBD)` AND have no dated heading above it. That admits every unreleased
    # section stacked at the top (a PR may open 1.16.3 while 1.16.2 is still open) and rejects a
    # stale `(TBD)` further down, which is stale exactly because a release was cut above it. A line
    # that IS a `## ` heading is section management - opening the next section, or a release dating
    # the current one - and is always allowed.
    added_lines=$(git diff --unified=0 "origin/${BASE_REF}" -- "${CHANGELOG_FILE}" \
        | awk '/^@@/ {
                 match($0, /\+[0-9]+(,[0-9]+)?/)
                 split(substr($0, RSTART + 1, RLENGTH - 1), p, ",")
                 count = (p[2] == "" ? 1 : p[2] + 0)
                 for (i = 0; i < count; i++) print (p[1] + 0) + i
               }')

    if [ -n "${added_lines}" ]; then
        # The line numbers arrive on stdin, not through `awk -v`: a -v value cannot carry literal
        # newlines, and awk aborts on one. Without `set -e` that abort is silent and the whole
        # check passes everything, so the failure is checked explicitly below.
        if ! misfiled=$(printf '%s\n' "${added_lines}" | awk '
            NR == FNR { if ($0 != "") want[$0 + 0] = 1; next }
            /^## / { heading = $0; if ($0 !~ /\(TBD\)/) released = 1 }
            (FNR in want) {
                if ($0 ~ /^## /) next
                if (heading == "") next
                if (released == 0 && heading ~ /\(TBD\)/) next
                print "  " FNR ": " $0
            }
        ' - "${CHANGELOG_FILE}"); then
            >&2 echo "check-changelog: placement check failed to run; refusing to pass it silently."
            exit 1
        fi

        if [ -n "${misfiled}" ]; then
            >&2 echo "These new ${CHANGELOG_FILE} lines are not under the newest, unreleased heading:"
            >&2 echo "${misfiled}"
            >&2 echo
            >&2 echo "Put them under the first \"## <version> (TBD)\" section, adding one above the"
            >&2 echo "newest published heading if none is open yet. If you meant to correct an entry"
            >&2 echo "in an already-published section, use the \"no changelog\" label."
            exit 1
        fi
    fi
fi
