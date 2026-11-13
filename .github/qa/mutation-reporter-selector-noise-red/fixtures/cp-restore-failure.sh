#!/bin/bash
# Fault injection: initial fix->backup copy works; backup->fix and cleanup restore fail.
if [ "${1:-}" = -p ] && [ "${2:-}" = -- ] && [[ "${3:-}" == */rev-mutate.*/backup ]]; then
  exit 1
fi
exec "${MQ_REAL_CP:?}" "$@"
