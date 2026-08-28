#!/usr/bin/env bash
set -euo pipefail

if ! command -v arduino-cli >/dev/null 2>&1; then
  echo "arduino-cli is required: https://arduino.github.io/arduino-cli/"
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
sketch_dir="$project_dir/firmware/uno-r4-wifi/SwitchboardAgent"
build_dir="$project_dir/firmware/uno-r4-wifi/build"

mkdir -p "$build_dir"
arduino-cli compile \
  --fqbn arduino:renesas_uno:unor4wifi \
  --warnings all \
  --output-dir "$build_dir" \
  "$sketch_dir"

echo "Firmware compiled in $build_dir"
