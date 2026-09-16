# SQLSaber for BB

This plugin adds SQLSaber to BB's provider picker. Each BB thread runs one `sqlsaber rpc` process. Assistant text, reasoning, and SQLSaber tools stream into the standard BB timeline. Stored query results appear as scrollable tables.

## Requirements

- BB 0.42 or newer with Plugin SDK 0.4.47 or newer.
- SQLSaber 0.77.0 or newer on each machine that runs the provider.
- A model and a database configured through the SQLSaber CLI.

Check SQLSaber before installing the plugin.

```sh
sqlsaber --version
sqlsaber models current
sqlsaber db list
```

## Install

```sh
npm install
bb plugin build
bb plugin install .
```

The provider appears only on machines where BB can find `sqlsaber` or `saber`. To use another executable, set `SQLSABER_EXECUTABLE` in the BB host daemon environment.

## Provider behavior

The plugin starts SQLSaber without `--allow-dangerous`. SQLSaber keeps its normal protection against writes and restricted DDL. BB exposes only the `full` permission mode because SQLSaber does not implement BB's workspace approval modes. Selecting `full` does not enable dangerous SQL.

The picker health check verifies the executable and its version. SQLSaber validates the configured model, credentials, and database when a thread starts, so startup errors appear on that thread without a separate probe opening the database.

The provider supports these operations:

- Start a persisted SQLSaber conversation.
- Resume a completed conversation after a BB or host restart.
- Stream assistant text and reasoning.
- Show SQLSaber tool calls in BB's standard tool rows.
- Queue steering text on an active SQLSaber run.
- Interrupt or release an active process.
- Map BB reasoning choices to SQLSaber thinking levels.
- Render stored SQL results with a plugin timeline renderer.

A table preview includes at most 100 rows, 100 columns, 1,000 cells, and 1,000 characters per cell. The row footer reports truncation. SQLSaber keeps the complete result in its own query-result store.

## Model selection

SQLSaber 0.77.0 does not expose per-session model selection over RPC. The BB picker therefore shows one entry named `configured`. Its display label reports the model selected on that machine when `sqlsaber models current` is available.

Change the model with SQLSaber, then reopen the BB model picker or start a new provider session.

```sh
sqlsaber models set provider:model
```

BB reasoning choices map as follows:

| BB | SQLSaber |
| --- | --- |
| Off | `off` |
| Low | `low` |
| Medium | `medium` |
| High | `high` |
| Maximum | `maximum` |

## Resume data

BB receives a plugin-owned provider session id. The bridge stores one small mapping file per session under the plugin data directory. The file contains only the provider session id and SQLSaber thread id. SQLSaber owns conversation history in its normal thread store.

Deleting a BB provider session removes its mapping file. Releasing a running thread keeps the file so BB can resume it later.

## Current limits

SQLSaber RPC accepts text only. The bridge rejects image and file inputs instead of dropping them. SQLSaber 0.77.0 does not provide BB-native fork, archive, rename, manual compaction, service tiers, user questions, or dynamic BB tools. The provider declaration leaves those capabilities disabled.

The bridge does not pass BB instructions into `--system-prompt`. That SQLSaber flag replaces the SQL agent's built-in prompt rather than appending instructions.

## Development

```sh
npm run typecheck
npm test
bb plugin types --check
bb plugin build
```

The test suite uses a deterministic RPC fixture for bridge conformance and stream projection. A separate smoke test launches the installed `sqlsaber` with an isolated home directory. The smoke test confirms the version and startup error without opening a database or loading user credentials.
