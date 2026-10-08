#!/usr/bin/env bash
# Replace one value in config.json.
#
# Usage: scripts/config-change.sh <section> <key> <new-value>
# Example: scripts/config-change.sh agglayer-testnet midenNetworkId 87
#
# The section and the key must exist, and the new value must have the type of the old value.
# The script does not restart the backend.
#
# The script reads the file by its layout, not with a JSON parser: each section starts with `  "<name>": {`,
# and each value is on its own line as `    "<key>": <value>`. Keep this layout in config.json.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: make config-change <section> <key> <new-value>" >&2
  exit 1
fi
export CONFIG_SECTION="$1" CONFIG_KEY="$2"
NEW_TEXT="$3"
NAME="$CONFIG_SECTION.$CONFIG_KEY"

CONFIG_FILE="$(cd "$(dirname "$0")/.." && pwd)/config.json"

fail() {
  echo "$1" >&2
  exit 1
}

# Print the old value as it is in the file (a string keeps its quotes).
OLD_RAW="$(awk '
  /^  "[^"]+": \{$/ {
    split($0, parts, "\"")
    in_section = (parts[2] == ENVIRON["CONFIG_SECTION"])
    if (in_section) found_section = 1
    sections = sections (sections == "" ? "" : ", ") parts[2]
    next
  }
  /^  \},?$/ { in_section = 0; next }
  in_section && /^    "[^"]+": / {
    split($0, parts, "\"")
    keys = keys (keys == "" ? "" : ", ") parts[2]
    if (parts[2] == ENVIRON["CONFIG_KEY"]) {
      value = substr($0, index($0, "\": ") + 3)
      sub(/,$/, "", value)
      found_key = 1
    }
  }
  END {
    if (!found_section) {
      print "Section \047" ENVIRON["CONFIG_SECTION"] "\047 is not in config.json. Sections: " sections > "/dev/stderr"
      exit 1
    }
    if (!found_key) {
      print "Key \047" ENVIRON["CONFIG_KEY"] "\047 is not in \047" ENVIRON["CONFIG_SECTION"] "\047. Keys: " keys > "/dev/stderr"
      exit 1
    }
    print value
  }
' "$CONFIG_FILE")"

ADDRESS_PATTERN='^0x[0-9a-fA-F]{40}$'

# Convert the new text to the type of the old value.
case "$OLD_RAW" in
  true | false)
    [[ "$NEW_TEXT" == true || "$NEW_TEXT" == false ]] || fail "$NAME is true or false"
    NEW_RAW="$NEW_TEXT"
    ;;
  \"*\")
    OLD_TEXT="${OLD_RAW#\"}"
    OLD_TEXT="${OLD_TEXT%\"}"
    if [[ "$OLD_TEXT" =~ $ADDRESS_PATTERN ]]; then
      [[ "$NEW_TEXT" =~ $ADDRESS_PATTERN ]] || fail "$NAME is an EVM address: 0x and 40 hex characters"
      # Lower case is always valid. Mixed case with a wrong checksum stops the server at start.
      NEW_TEXT="$(printf '%s' "$NEW_TEXT" | tr 'A-F' 'a-f')"
    fi
    [[ "$NEW_TEXT" != *\"* && "$NEW_TEXT" != *\\* ]] || fail "$NAME must not contain a quote or a backslash"
    NEW_RAW="\"$NEW_TEXT\""
    ;;
  *)
    [[ "$OLD_RAW" =~ ^-?[0-9]+$ ]] || fail "$NAME has a type that this command cannot change"
    [[ "$NEW_TEXT" =~ ^-?[0-9]+$ ]] || fail "$NAME is an integer"
    NEW_RAW="$NEW_TEXT"
    ;;
esac

if [[ "$NEW_RAW" == "$OLD_RAW" ]]; then
  echo "$NAME is already $OLD_RAW. No change."
  exit 0
fi

WORK_FILE="$(mktemp)"
trap 'rm -f "$WORK_FILE"' EXIT

CONFIG_VALUE="$NEW_RAW" awk '
  /^  "[^"]+": \{$/ {
    split($0, parts, "\"")
    in_section = (parts[2] == ENVIRON["CONFIG_SECTION"])
  }
  /^  \},?$/ { in_section = 0 }
  in_section && /^    "[^"]+": / {
    split($0, parts, "\"")
    if (parts[2] == ENVIRON["CONFIG_KEY"]) {
      comma = ($0 ~ /,$/) ? "," : ""
      print "    \"" parts[2] "\": " ENVIRON["CONFIG_VALUE"] comma
      next
    }
  }
  { print }
' "$CONFIG_FILE" > "$WORK_FILE"
cat "$WORK_FILE" > "$CONFIG_FILE"

echo "$NAME: $OLD_RAW -> $NEW_RAW"
echo "Apply it with: docker compose restart backend"
echo "The wallet build must have the same value, or the server rejects each signature."
