#!/usr/bin/env bash
# Builds the remote-control input helper for macOS student computers as a
# universal (Apple silicon + Intel) binary. The Windows helper is a PowerShell
# script and needs no build step.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Skipping the macOS input helper (needs a Mac with Xcode command line tools)."
  exit 0
fi

out=native-bin/darwin
mkdir -p "$out"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos11" native/macos/InputHelper.swift -o "$out/input-helper-$arch"
done
lipo -create -output "$out/input-helper" "$out/input-helper-arm64" "$out/input-helper-x86_64"
rm "$out/input-helper-arm64" "$out/input-helper-x86_64"
echo "Built $out/input-helper"
