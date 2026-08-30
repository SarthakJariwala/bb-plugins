# Sprite Keepalive for BB

A server-only BB plugin that keeps a [Sprite](https://sprites.dev) awake while BB has useful work, then releases it when BB becomes idle.

BB remains a Sprite **Service** so it restarts after a cold wake. This plugin adds one renewable Sprite **Task** lease so detached agent work is not suspended after the browser disconnects.

## Behavior

The plugin scans all non-archived threads, including hidden threads. It holds one Task when any thread:

- is `starting`, `active`, or `stopping`; or
- has an active background agent, background command, or workflow.

Goals and plan-mode indicators alone do not count as executing work. Active threads waiting for user input remain protected conservatively.

Lease behavior:

- Task name: `bb-active-work-<server-port>`
- Task expiry: 5 minutes
- Heartbeat: 60 seconds
- Idle release grace: 7.5 seconds, followed by a confirmation scan
- Retry: exponential from 5 to 30 seconds
- API: `PUT`/`DELETE /v1/tasks/<name>` over `/.sprite/api.sock`

A scan failure never causes a lease deletion. A plugin or BB crash cannot create an immortal lease because heartbeats stop and the Task expires after five minutes.

Outside a Sprite, the missing management socket is detected and the plugin stays loaded but inactive.

## Install

```bash
cd bb-plugin-sprite-keepalive
npm install
bb plugin install .
```

For a BB server listening on port 8080:

```bash
BB_SERVER_URL=http://127.0.0.1:8080 bb plugin install .
```

Reload after editing:

```bash
BB_SERVER_URL=http://127.0.0.1:8080 bb plugin reload sprite-keepalive
```

## Inspect

```bash
bb sprite-keepalive status
bb sprite-keepalive status --json
bb plugin logs sprite-keepalive
sprite-env curl /v1/tasks
```

The JSON status includes Sprite detection, Task name and held state, active thread count and bounded IDs, last successful scan/heartbeat times, and the latest error.

## Development

```bash
npm test
npm run typecheck
npm run build
```

The tests cover work classification, hidden/paginated inventory, serialized reconciliation, idle confirmation, failure safety, shutdown cleanup, the BB plugin harness, and the Unix-socket Sprite Tasks client.

## Security and scope

- Uses only the local Sprite Unix socket; no API token or public endpoint is added.
- Reads thread status/activity metadata only, never prompts, outputs, or provider credentials.
- Protects the Sprite running the central BB server. A separate remote execution Sprite needs its own local lifecycle integration.
- The Sprite URL should remain authenticated.
