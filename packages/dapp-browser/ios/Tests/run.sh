#!/bin/sh
set -eu
TEST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_OUTPUT=$(mktemp -d)
trap 'rm -rf "$TEST_OUTPUT"' EXIT
swiftc "$TEST_DIR/../Sources/InAppBrowserPlugin/BreadPresentationState.swift" "$TEST_DIR/main.swift" -o "$TEST_OUTPUT/presentation-tests"
"$TEST_OUTPUT/presentation-tests"
