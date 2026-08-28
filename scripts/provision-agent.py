#!/usr/bin/env python3
"""Provision a manually flashed SWITCHBOARD Agent over USB serial."""

from __future__ import annotations

import argparse
import getpass
import json
import sys
import time


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Provision SWITCHBOARD Agent v0.5.x")
    parser.add_argument("--port", required=True, help="Serial port, for example /dev/ttyACM0 or COM5")
    parser.add_argument("--ssid", required=True, help="Wi-Fi network name")
    parser.add_argument("--server-host", required=True, help="Device-accessible hostname without scheme or path")
    parser.add_argument("--enrollment-token", required=True, help="Unused swenr_ token from SWITCHBOARD")
    parser.add_argument("--device-name", default="UNO R4 WiFi", help="Human-readable device name")
    parser.add_argument("--server-port", type=int, default=443)
    parser.add_argument("--insecure", action="store_true", help="Use plaintext HTTP/WebSocket for isolated local development only")
    parser.add_argument("--timeout", type=float, default=12.0, help="Seconds to wait for a non-secret device response")
    return parser.parse_args()


def main() -> int:
    args = arguments()
    if "/" in args.server_host or ":" in args.server_host:
        raise SystemExit("--server-host must be a hostname only; omit https:// and paths")
    if not args.enrollment_token.startswith("swenr_"):
        raise SystemExit("--enrollment-token must be an unused SWITCHBOARD token")
    if not 1 <= args.server_port <= 65535:
        raise SystemExit("--server-port must be between 1 and 65535")
    try:
        import serial  # type: ignore[import-not-found]
    except ImportError:
        raise SystemExit("pyserial is required: python3 -m pip install pyserial") from None

    wifi_password = getpass.getpass("Wi-Fi password (not echoed): ")
    payload = {
        "action": "provision",
        "deviceName": args.device_name,
        "wifiSsid": args.ssid,
        "wifiPassword": wifi_password,
        "serverHost": args.server_host,
        "serverPort": args.server_port,
        "secure": not args.insecure,
        "enrollmentToken": args.enrollment_token,
    }
    print("Opening serial port; secrets will not be printed.")
    with serial.Serial(args.port, 115200, timeout=0.25) as connection:
        time.sleep(1.5)
        connection.reset_input_buffer()
        connection.write((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
        connection.flush()
        deadline = time.monotonic() + max(2.0, args.timeout)
        while time.monotonic() < deadline:
            line = connection.readline().decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            code = str(event.get("code", ""))
            if code == "PROVISION_STORED":
                print("Provisioning stored. The board is restarting and will exchange its one-time token.")
                return 0
            if event.get("level") == "ERROR":
                print(f"Device rejected provisioning: {code or 'unknown error'}", file=sys.stderr)
                return 2
    print("No provisioning acknowledgment arrived. Reopen Serial Monitor at 115200 baud and send {\"action\":\"status\"}.", file=sys.stderr)
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
