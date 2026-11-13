#!/bin/bash
# Fault injection, never install on an owner tree: report apply success but change no bytes.
if [ "${1:-}" = apply ]; then exit 0; fi
exec "${MQ_REAL_GIT:?}" "$@"
