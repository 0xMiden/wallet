run_logged() {
  local stem="$1"
  shift
  printf '%s\0' "$@" > "$stem.argv"
  set +e
  "$@" 2>&1 | tee "$stem.log"
  local codes=("${PIPESTATUS[@]}")
  set -e
  printf '%s\n' "${codes[0]}" > "$stem.exit"
  printf '%s\n' "${codes[1]}" > "$stem.tee.exit"
  if [ "${codes[1]}" -ne 0 ]; then
    return "${codes[1]}"
  fi
  return "${codes[0]}"
}
