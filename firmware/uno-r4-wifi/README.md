# Arduino UNO R4 WiFi Agent

`SwitchboardAgent/SwitchboardAgent.ino` is the Batch 7 Device Workbench
candidate for the Arduino UNO R4 WiFi. It runs as normal Renesas RA4M1 user
firmware through WiFiS3 and does not replace the ESP32-S3 USB bridge firmware.

## Validation status

Agent `0.8.0-device-workbench-candidate` is aligned with SWITCHBOARD Device Protocol 1
and its server contract tests pass. It requests 14-bit Analog-to-Digital
Converter (ADC) reads and 12-bit Pulse Width Modulation (PWM) and
Digital-to-Analog Converter (DAC) writes. It has not been compiled in this
repository's current environment or accepted on physical hardware. Do not
publish it as a known-good browser-flash binary until the Hardware-in-the-Loop
(HIL) record passes.

SWITCHBOARD Community v0.10 automation is implemented on the server and continues to use
the same acknowledged Device Protocol 1 commands. It does not add firmware rule
execution or justify renaming this candidate. Physical automation remains behind
the core and supplementary HIL procedures; simulator or
dry-run evidence is not a physical pass.

For automation admission, a core HIL record is current only while its captured
agent and firmware versions and its configuration version bound at pass still
match the device. That match is an interlock, not a claim that Batch 8 physical
automation has completed its supplementary validation.

## Pinned toolchain

- `arduino:renesas_uno@1.5.2`
- `ArduinoJson@7.4.3`
- `WebSockets@2.7.2`
- `ArduinoHttpClient@0.6.1`
- WiFiS3 and EEPROM from the board core

Install and compile:

```bash
./scripts/setup-firmware-toolchain.sh
./scripts/build-firmware.sh
```

Upload with Arduino IDE or `arduino-cli upload` using the compiled sketch and
the board's serial port. The browser can identify, provision, enter the
bootloader, and recover the board, but erase/write remains locked until HIL passes.

## Provision over USB serial

Open Browser Provisioning in desktop Chromium to create a 15-minute enrollment
token and write the secret payload directly at 115200 baud. Otherwise copy the
generated single-line fallback into Serial Monitor or run:

```bash
python3 -m pip install pyserial
./scripts/provision-agent.py \
  --port /dev/ttyACM0 \
  --ssid WorkshopWiFi \
  --server-host switchboard.example.com \
  --enrollment-token 'swenr_…'
```

The script prompts for the Wi-Fi password without echoing it. The device stores
the configuration in EEPROM, exchanges the one-time token over HTTPS, saves the
returned permanent credential, erases the token, and authenticates its secure
WebSocket. Use plaintext only with `--insecure` on an isolated local network.
The UNO R4 WiFi connectivity module must trust the endpoint's certificate chain;
install the required root certificate with Arduino's board firmware/certificate
workflow before testing a private certificate authority.

The server setting is a hostname, not a URL or path. Community v0.10 supports a
dedicated host such as `switchboard.example.com`; path-prefix hosting is not
supported.

Serial commands are newline-delimited JSON:

```json
{"action":"status"}
{"action":"identify"}
{"action":"clear"}
```

The Batch 7 workbench console exposes only `status` and `identify`. `clear`
erases network configuration and the stored credential and therefore remains in
the guided recovery flow with explicit confirmation. Revoking the credential on
the server should still be the first response to suspected loss.

## Runtime behavior

- Every managed D0–D13 and A0–A5 pin starts as `INPUT` before configuration loads.
- Wi-Fi and socket retries double up to a 60-second maximum and continue recovery.
- The agent authenticates first, sends a heartbeat and complete pin snapshot,
  waits for `device.snapshot.ack`, then polls for one acknowledged GPIO command
  at a time and reports safe logs.
- Analog-capable A0–A5 report 14-bit raw samples; PWM-capable pins and DAC-capable
  A0 accept exact 12-bit values only while configured in the matching mode.
- Mode changes and digital, PWM, and DAC writes acknowledge the exact command ID,
  pin, mode, and confirmed value before server state changes.
- Log messages use bounded codes/text and never intentionally include stored secrets.
- Heartbeats report firmware-local `SAFE_INPUT_BOOT`: every managed pin starts as
  input. This candidate has no autonomous link-loss timer or local link-loss
  safe-state implementation.
- A server safe-state profile is a remote set of acknowledged commands. It is not
  firmware-local behavior and cannot protect hardware after communication loss.
- The permanent device credential is stored in board EEPROM; physical access is a
  credential-exposure boundary. Revoke and reprovision after loss or reassignment.

See `docs/hardware-in-the-loop.md` for the acceptance procedure.
