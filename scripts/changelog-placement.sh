#!/bin/bash
set -uo pipefail

# Judges each line a pull request added to the CHANGELOG by the `## <version>` heading that governs
# it. The added line numbers (new-file numbering, one per line) arrive on stdin.
#
# An added line passes when it is:
#   - a `## ` heading itself (opening, dating or closing a section),
#   - blank or whitespace-only,
#   - above every version heading and not a list entry (the file's preamble), or
#   - governed by a heading whose version is strictly newer than the latest release.
# The version decides, not a `(TBD)` marker: a `(TBD)` heading can outlive its release.
#
# Exit 0: every added line is placed where an unreleased entry belongs. Exit 1: at least one is not,
# and each is printed. Exit 2: the input could not be read, so nothing was judged.

usage='usage: changelog-placement.sh <changelog> <latest-release X.Y.Z> < added-line-numbers'
changelog=${1:?$usage}
latest=${2:?$usage}

if ! printf '%s\n' "${latest}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    >&2 echo "changelog-placement: the latest release must be X.Y.Z, got '${latest}'."
    exit 2
fi
if [ ! -r "${changelog}" ]; then
    >&2 echo "changelog-placement: cannot read ${changelog}."
    exit 2
fi

if ! added=$(cat); then
    >&2 echo "changelog-placement: could not read the added line numbers."
    exit 2
fi
if [ -n "${added}" ] && printf '%s\n' "${added}" | grep -Evq '^[1-9][0-9]*$'; then
    >&2 echo "changelog-placement: the added line numbers must be positive integers, one per line."
    exit 2
fi

# The numbers go in as one comma-separated value: `awk -v` cannot carry a newline, and reading them
# as a first input file breaks the NR == FNR idiom when that file is empty.
awk -v latest="${latest}" -v added_list="$(printf '%s' "${added}" | tr '\n' ',')" '
    function newer(version,    a, b, i) {
        split(version, a, ".")
        split(latest, b, ".")
        for (i = 1; i <= 3; i++) if (a[i] + 0 != b[i] + 0) return a[i] + 0 > b[i] + 0
        return 0
    }
    function report(reason) {
        printf "%s:%d: %s: %s\n", FILENAME, FNR, reason, $0
        bad = 1
    }
    BEGIN {
        n = split(added_list, list, ",")
        for (i = 1; i <= n; i++) if (list[i] != "") added[list[i]] = 1
    }
    /^## / {
        heading = $0
        split(substr($0, 4), words, " ")
        version = words[1]
    }
    !(FNR in added) { next }
    /^## / || /^[ \t]*$/ { next }
    heading == "" {
        if ($0 ~ /^[ \t]*[-*+] /) report("an entry above every version heading")
        next
    }
    version !~ /^[0-9]+\.[0-9]+\.[0-9]+$/ { report("under \"" heading "\", which names no X.Y.Z version"); next }
    !newer(version) { report("under \"" heading "\", but " version " is not newer than the latest release, " latest); next }
    END { exit bad ? 1 : 0 }
' "${changelog}"
