---
name: reflect
description: Spawn three parallel visible BB child threads over the active thread log, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

## When to invoke

- The user said "reflect" or "/reflect".
- A complex task (5+ tool calls) just landed cleanly and the recipe is worth keeping.
- The agent hit dead ends, found the working path, and the path generalizes.
- The user corrected the agent's approach mid-task.
- A non-trivial workflow emerged that isn't captured anywhere.

Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Capture the active thread

The parent exports only its own BB thread log before fanning out. Use the current thread ID and write the complete JSON log to a unique temporary file on the shared host:

```bash
bb thread log --self --all --format json > "/tmp/pstack-reflect-${BB_THREAD_ID}.json"
```

Do not list or search unrelated threads. If export fails, write a tight digest of this session and pass that instead.

### 2. Spawn three reviewers in parallel

Call `pstack_get_model_config`, then make one `pstack_spawn_threads` call with three workers. Use `preset: "general"`, `readOnly: true`, and `workspace: "reuse"`. Give each worker its named lens as a distinct scope.

| Lens | `role` | Prompt template |
|---|---|---|
| Judgment | `reflect-judgment` | `references/judgment-reviewer.md` |
| Tooling | `reflect-tooling` | `references/tooling-reviewer.md` |
| Divergent | `reflect-judgment` | `references/divergent-reviewer.md` |

Give each child the matching template path and the thread-log artifact path or digest. Do not paste the template or log into the brief. Do not wait with a tool. Continue after BB's child-completion messages cover every reviewer. Keep their thread IDs as evidence pointers; do not fetch duplicate full outputs into the parent.

### 3. Synthesize

Spawn one child with `pstack_spawn_threads`, using `preset: "general"`, `role: "reflect-judgment"`, `readOnly: true`, and `workspace: "reuse"`. The synthesizer's quality check includes spot-verifying citations. Point it to `references/synthesizer.md`, the three reviewer thread IDs, and the thread-log artifact path. Do not inline those payloads. It can read the named child logs with `bb thread log <thread-id> --all --format json`. Do not wait with a tool. After BB's child-completion message, it returns a structured Accepted / Rejected / Backlog list.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. The synthesizer already applies this criterion; this is a final pass before edits land. See the **encode-lessons-in-structure** principle skill.

### 5. Apply

Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval. The user picks which subset to apply and may redirect routings. Skill changes affect every future agent in the org; do not auto-apply.

Backlog items file to whatever devex / backlog tracker your team uses automatically. Those are tracker submissions, not skill edits. Only the Accepted list waits for approval.

For each approved Accepted item, follow the Routing field exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to BB's `skill-creator` skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `skill-creator` and run its description-optimization loop.
- `new skill via skill-creator: <kebab-name>`: hand creation to `skill-creator`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done. Skip this step if it doesn't.

### 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
