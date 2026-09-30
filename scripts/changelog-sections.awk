# Labels every line of a CHANGELOG with the section it belongs to. This is the one definition of a
# heading and a section, shared by the changelog gate (scripts/check-changelog.sh) and the release
# notes (scripts/changelog-notes.sh, run by .github/workflows/release-notes.yml), so the gate judges
# a line where the notes would publish it.
#
# A heading is any line whose first whitespace-separated field is exactly "##", so an indented or
# tab-led one counts; its version is its second field. A line that is exactly "---" ends the section
# it is in, and the lines after it belong to no section until the next heading.
#
# Output, one line per input line: <line number> TAB <version> TAB <kind> TAB <text>. kind is
# preamble, heading, section, separator or outside; version is set for heading and section lines
# only; text is the line verbatim and comes last because it may hold tabs. POSIX awk only: CI runs
# mawk and macOS ships BSD awk.
BEGIN { OFS = "\t"; state = "preamble"; version = "" }
$1 == "##" { version = $2; state = "section"; print NR, version, "heading", $0; next }
$0 == "---" { version = ""; state = "outside"; print NR, "", "separator", $0; next }
state == "section" { print NR, version, "section", $0; next }
{ print NR, "", state, $0 }
