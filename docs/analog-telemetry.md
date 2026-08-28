# Analog Telemetry and Modulated Outputs

Batch 6 adds a bounded analog path for the Arduino UNO R4 WiFi profile. The
profile uses 14-bit Analog-to-Digital Converter (ADC) samples and a 5 V reference:

```text
voltage = raw / 16383 × 5 V
```

An optional two-point calibration converts voltage to an engineering value:

```text
engineering = outputLow +
  (voltage - inputLow) / (inputHigh - inputLow) × (outputHigh - outputLow)
```

All four calibration points must be present or absent. Input points must be
distinct and within 0–5 V, output points must be distinct, and a calibrated pin
must have a bounded unit label. Extrapolation is intentional: a sample outside
the two input points can yield an engineering value outside the two output
points, while the raw ADC value remains bounded.

## Persistence and export

Each accepted sample retains raw count, voltage, engineering value, unit,
snapshot sequence, and server-recorded time. The write path accepts at most one
persisted sample per device pin per second and prunes each pin to its newest 720
samples. The list and Comma-Separated Values (CSV) export routes cap reads at the
same per-pin retention maximum. The live monitor charts these persisted samples;
it does not synthesize browser-only history.

## Pulse Width Modulation and Digital-to-Analog Converter outputs

Pulse Width Modulation (PWM) and Digital-to-Analog Converter (DAC) writes use
integer counts from 0 through 4095. The workbench shows PWM as duty percentage
and DAC as an approximate 0–5 V level, while the protocol carries the exact
12-bit count. Capability and current mode are validated before queuing. Confirmed
state changes only after a matching command acknowledgment arrives before the
five-second deadline.

The UNO R4 WiFi exposes DAC output on A0 and PWM only on the pins declared by the
validated board profile. Arduino documents the board's DAC behavior in the
[UNO R4 WiFi cheat sheet](https://docs.arduino.cc/tutorials/uno-r4-wifi/cheat-sheet),
and the [ArduinoCore-renesas analog implementation](https://github.com/arduino/ArduinoCore-renesas/blob/main/cores/arduino/analog.cpp)
defines the resolution scaling used by `analogReadResolution` and
`analogWriteResolution`.

## Automation source boundary

Batch 8 threshold rules can compare the latest confirmed analog engineering
value. The rule records the source device configuration version and engineering
unit when it is saved. A changed calibration, unit, pin mode, missing source,
offline or unsynchronized physical device, or sample older than the configured
maximum age blocks evaluation and resets any `FOR` window.

A physical threshold source also requires a current passing HIL record whose
pass-bound device configuration version and start-captured agent and firmware
versions match the device.
That admission interlock does not validate the physical sensor or automation
behavior.

The one-sample-per-second persistence limit is a storage ceiling, not a promised
physical sample rate. The current physical agent normally publishes a full
snapshot no more often than every five seconds, and network or device activity
can add delay. A `FOR` duration advances between fresh server-recorded samples;
it does not infer continuous truth from wall-clock time or interpolate across a
gap. Automation timing is therefore not high-speed data acquisition, real-time
control, or a safety limit.

Dry run records the value, unit, sample time, match decision, and planned action
without creating a General-Purpose Input/Output command. Live automation can
request only one absolute bounded output action through the normal exact
acknowledgment path. See `docs/automation.md` for the complete contract.

## Physical validation boundary

The server, simulator, browser interface, and firmware source contracts are
tested. The current v0.8 physical agent remains a candidate: this repository has not
compiled it in the current environment, flashed it to a board, or completed the
Hardware-in-the-Loop (HIL) acceptance procedure. Analog support does not unlock
browser erase/write, and Batch 8 simulator automation tests do not validate a
physical threshold or output.
