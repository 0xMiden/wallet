#!/bin/bash
set -uo pipefail

# Prints the release notes for one version: the body of the first CHANGELOG section headed by it, as
# scripts/changelog-sections.awk reads headings and sections, with empty lines trimmed from both
# ends. .github/workflows/release-notes.yml publishes what this prints. Prints nothing and exits 0
# when no section has that version; exits 2 when the file cannot be read or the parser fails.

usage='usage: changelog-notes.sh <version> [<changelog>]'
version=${1:?$usage}
changelog=${2:-CHANGELOG.md}

if [ ! -r "${changelog}" ]; then
    >&2 echo "changelog-notes: cannot read ${changelog}."
    exit 2
fi

# The first heading with this version opens the body; the next heading or --- line ends it. The
# second awk reads all its input rather than exiting early, so a long CHANGELOG cannot SIGPIPE the
# first under pipefail.
if ! awk -f "$(dirname "$0")/changelog-sections.awk" "${changelog}" | awk -F '\t' -v version="${version}" '
    done { next }
    $3 == "heading" { if (found) done = 1; else if ($2 == version) found = 1; next }
    $3 != "section" { if (found) done = 1; next }
    found {
        n++
        line[n] = substr($0, length($1) + length($2) + length($3) + 4)
        if (line[n] != "") { if (!first) first = n; last = n }
    }
    END { if (first) for (i = first; i <= last; i++) print line[i] }
'; then
    >&2 echo "changelog-notes: could not read the sections of ${changelog}."
    exit 2
fi
