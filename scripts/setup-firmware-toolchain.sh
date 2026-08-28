#!/usr/bin/env bash
set -euo pipefail

if ! command -v arduino-cli >/dev/null 2>&1; then
  echo "arduino-cli is required: https://arduino.github.io/arduino-cli/"
  exit 1
fi

arduino-cli core update-index
arduino-cli core install "arduino:renesas_uno@1.5.2"
arduino-cli lib install "ArduinoJson@7.4.3"
arduino-cli lib install "WebSockets@2.7.2"
arduino-cli lib install "ArduinoHttpClient@0.6.1"

echo "SWITCHBOARD firmware toolchain is ready."
