# Session Import for BB

Continue sessions started in the Claude Code, Codex, or Pi CLI as BB-managed threads.

## What it does

- Discovers CLI sessions from each connected machine's normal provider data directory.
- Shows recent sessions in a **CLI Sessions** sidebar page.
- Creates a hidden BB-managed bootstrap in the session's original workspace and stops it as soon as the provider assigns an identity.
- Copies and rekeys the provider session into that BB-managed session location.
- Leaves the original CLI session untouched.
- Cold-resumes the imported provider history when you send the first message in BB.

The provider receives the full imported history as context. BB's visible timeline begins with the first message sent after import; a composer banner makes that boundary explicit.

## Install

```sh
bb plugin install ./bb-plugin-session-import
```

Then open **CLI Sessions** in the BB sidebar.

## Supported layouts

| Provider | Source directory |
| --- | --- |
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex/sessions` and `~/.codex/archived_sessions` |
| Pi | `~/.pi/agent/sessions` |

Session discovery and migration use BB's host file API, so they run on the selected connected machine rather than assuming the BB server's local filesystem.

## Safety

Import is copy-based. The source file is never modified or removed. BB first creates and unloads a hidden managed provider bootstrap, then replaces only that new session's file using an optimistic file hash guard.

Very large provider logs remain subject to BB's host file read/write limits.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```
