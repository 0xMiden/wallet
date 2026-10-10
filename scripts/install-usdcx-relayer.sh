#!/usr/bin/env bash
# Install the pinned xReserve deposit relayer for the live USDCx bridge-in E2E.
#
# The miden-usdcx project publishes only the `usdcx-bridge` Docker image, which
# starts the withdrawal attester too and so needs AWS KMS keys. The stand-alone
# relayer has no published binary, so this script builds it from the pinned tag.
# CI caches the result (`~/.cargo/bin/xreserve-deposit-relayer`), so only the
# first run after a pin change compiles.
#
# A binary that is already installed is kept. To use a downloaded binary instead,
# set USDCX_RELAYER_BIN to its path when you run the suite; this script is then
# not necessary.
set -euo pipefail

USDCX_RELAYER_REPO="${USDCX_RELAYER_REPO:-https://github.com/0xMiden/miden-usdcx}"
# Must agree with the Miden protocol line of the wallet's SDK (0.17.x).
USDCX_RELAYER_TAG="${USDCX_RELAYER_TAG:-v0.17.1}"
# The toolchain that miden-usdcx pins in its rust-toolchain.toml at this tag.
USDCX_RELAYER_TOOLCHAIN="${USDCX_RELAYER_TOOLCHAIN:-1.98.1}"
BIN="${CARGO_HOME:-$HOME/.cargo}/bin/xreserve-deposit-relayer"

if [[ -x "$BIN" ]]; then
  echo "xreserve-deposit-relayer is already installed at $BIN"
  exit 0
fi

rustup toolchain install "$USDCX_RELAYER_TOOLCHAIN" --profile minimal
cargo "+$USDCX_RELAYER_TOOLCHAIN" install \
  --git "$USDCX_RELAYER_REPO" \
  --tag "$USDCX_RELAYER_TAG" \
  --locked \
  xreserve-deposit-relayer

echo "Installed xreserve-deposit-relayer ($USDCX_RELAYER_TAG) at $BIN"
