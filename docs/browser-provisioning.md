# Browser Provisioning and Recovery

Batch 5 supports the Arduino UNO R4 WiFi in a secure-context desktop Chromium
browser through Web Serial. It does not claim browser erase/write is ready.

## Supported local operations

1. Request a USB port filtered to Arduino VID `0x2341` and UNO R4 WiFi product
   IDs `0x1002` (runtime) or `0x006D` (bootloader).
2. Identify the running SWITCHBOARD agent at 115200 baud without returning secrets.
3. Verify the published candidate source bytes against the SHA-256 digest in
   `public/firmware/manifest-v1.json`.
4. Create a short-lived server enrollment token, then send Wi-Fi and endpoint
   settings directly from the browser to the board over USB.
5. Read non-secret configuration/enrollment/socket status or erase stored
   network and device credentials after explicit confirmation.
6. Touch the runtime port at 1200 baud to request bootloader entry and reselect
   the changed port, or double-tap RESET for manual recovery.

## Batch 7 browser-local console

The Device Workbench console uses the selected runtime port at 115200 baud in
desktop Chromium. It accepts only `status` and `identify`; provisioning and
credential clearing remain guided workflows. Display and export use a bounded
300-line browser ring and credential-shaped text is redacted. Console bytes are
not uploaded to the server or persisted as agent logs. Connecting or identifying
a board is not a flash, electrical, or physical Hardware-in-the-Loop (HIL)
validation claim.

## Batch 8 automation boundary

Automation is evaluated by the server and does not add a Web Serial command,
bootloader operation, browser-flash package, or new device-protocol message. The
physical agent therefore remains `0.8.0-device-workbench-candidate`. A dry-run
or simulator automation result is not evidence that the source, target, wiring,
timing, or output has passed physical HIL validation.

The server refuses to arm a physical target for automation without a current
passing HIL record, and a physical threshold source requires the same current
evidence. Current means the HIL record's pass-bound device configuration version
and start-captured agent and firmware versions still match the device. A changed
configuration or reported version requires a new physical run. This interlock
does not complete the supplementary Batch 8 procedure or make physical
automation a validated release capability. Browser provisioning, firmware
integrity, and erase/write gates remain unchanged.

## Flash interlock

The UNO R4 WiFi board core declares a `bossac` / `sam-ba` application upload,
a 1200-bps touch reset, and a 262,144-byte maximum. The bootloader port may
change after the reset. Batch 5 records those facts and implements the reset and
reselection boundary, but publishes `binary: null` and
`hardwareVerification.passed: false`.

The release therefore rejects erase/write before any programming command. To
activate it later, the release process must provide all of the following:

- a reproducibly compiled RA4M1 application binary within the size bound;
- its exact byte length and SHA-256 digest;
- a passing physical HIL run identifier and verification timestamp; and
- a tested browser SAM-BA extended write/readback implementation.

The manifest hash detects corruption or mismatch. Authenticity still depends on
the owner-authenticated TLS origin and its release process; a same-origin hash is
not a code-signing signature.

## Recovery boundary

Application recovery targets the Renesas RA4M1 bootloader only. Do not use this
workflow to replace the separate ESP32-S3 USB bridge firmware. If the runtime
port is missing, double-tap RESET, wait for the pulsing L LED, select the
bootloader port, and use the pinned Arduino toolchain for a manual upload until
the browser write gate is accepted.

Primary board references:

- [ArduinoCore-renesas board upload definitions](https://github.com/arduino/ArduinoCore-renesas/blob/main/boards.txt)
- [ArduinoCore-renesas bootloader upload sequence](https://github.com/arduino/ArduinoCore-renesas/issues/73)
- [Arduino UNO R4 WiFi cheat sheet](https://docs.arduino.cc/tutorials/uno-r4-wifi/cheat-sheet)
- [Arduino UNO R4 WiFi USB HID recovery guidance](https://docs.arduino.cc/tutorials/uno-r4-wifi/usb-hid)
- [Arduino UNO R4 WiFi USB bridge repository](https://github.com/arduino/uno-r4-wifi-usb-bridge)
