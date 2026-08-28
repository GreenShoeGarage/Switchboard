# Server foundation

The v0.1.0 release defines protocol types and a reusable device simulator. The
persistent authenticated server, WebSocket endpoint, migrations, and role model
enter in Batches 1 and 2. They are not represented by fake in-memory production
routes.

`simulator.mjs` provides a small acknowledgment-oriented state machine for
development and automated tests.
