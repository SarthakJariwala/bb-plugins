# bb-plugin-review

A starter bb plugin inspired by `~/.pi/agent/extensions/review.ts`.

It provides:

- a **Review** button in every thread header;
- a side-panel target picker for uncommitted changes, a base branch, commit, GitHub PR, paths, or custom instructions;
- isolated reviews in a visible child thread that reuses the parent environment;
- current-thread reviews;
- an embedded `ThreadChat` for the isolated reviewer;
- **Apply findings**, which sends one-shot review output back to the parent thread as an implementation task;
- durable loop fixing that alternates review and parent-thread fix passes until no P0-P2 findings remain (maximum 10 reviews);
- realtime loop progress and cancellation in the panel;
- a `bb review` CLI command;
- a `/review` agent skill;
- configurable review-guidelines filename.

## Pi-to-bb mapping

| Pi review extension | bb plugin starter |
| --- | --- |
| `/review` command | `/review` skill, Review header button, and `bb review` CLI |
| TUI preset selector | Thread side-panel form |
| Empty branch | Separate child thread sharing the environment |
| Current session | Current-thread mode |
| `/end-review` + fix | **Apply findings** |
| `REVIEW_GUIDELINES.md` | Agent is instructed to discover the configured filename |
| Loop fixing | Background `review-loop` service with durable KV state and realtime panel updates |

The review rubric and target-mode prompts are kept verbatim from `~/.pi/agent/extensions/review.ts`. PR mode follows the Pi behavior and asks the reviewer to resolve metadata with `gh`, check out the PR, and review it against its base branch.

## Files to customize

- [`prompts.ts`](./prompts.ts) — review rubric, target-specific prompts, and apply-findings prompt.
- [`server.ts`](./server.ts) — RPC handlers, child-thread spawning, KV session links, settings, and `bb review`.
- [`app.tsx`](./app.tsx) — header action, target picker, embedded review chat, and apply button.
- [`skills/review/SKILL.md`](./skills/review/SKILL.md) — when agents should invoke the plugin command.
- [`package.json`](./package.json) — plugin identity, compatibility, branding, and entries.

## Develop

The plugin is installed in place, so use the watch loop from this directory:

```sh
bb plugin dev
```

Or run checks manually:

```sh
npm install
npm test
npm run typecheck
npm run build
bb plugin reload review
bb plugin logs review -f
```

Inspect status and settings:

```sh
bb plugin list
bb plugin config review
bb plugin config review set isolatedByDefault true
bb plugin config review set guidelinesFile REVIEW_GUIDELINES.md
```

## CLI

Run these from a bb thread so the CLI context includes the parent thread ID:

```sh
bb review start uncommitted
bb review start branch main
bb review start commit abc123
bb review start pr 123
bb review start folder src tests
bb review start custom focus on authorization boundaries
bb review start --loop uncommitted
bb review start --loop branch main

bb review status
bb review apply
bb review stop
bb review clear
```

Add `--current` after `start` to review in the current thread:

```sh
bb review start --current uncommitted
```

## Customization walkthrough

### 1. Change what reviewers flag

Edit `REVIEW_RUBRIC` in `prompts.ts`. Keep the output contract stable if you later automate finding parsing: priority-tagged findings and an exact final verdict.

### 2. Add a review target

1. Add it to `ReviewTarget` and `targetInstructions()` in `prompts.ts`.
2. Add the matching Zod branch to `reviewTargetSchema` in `server.ts`.
3. Add the target row, detail input, and `makeTarget()` branch in `app.tsx`.
4. Add CLI parsing in `parseCliTarget()` and update skill usage.

The RPC schema validates both frontend input and backend output.

### 3. Change isolated-thread behavior

Customize `startReview()` in `server.ts`. It currently:

- reads the parent via `bb.sdk.threads.get()`;
- reuses its environment;
- keeps the same provider;
- creates a visible child when the host permits child threads;
- stores the parent/review link in namespaced KV.

Use `visibility: "hidden"` for background-only review workers, or pass model/reasoning defaults if reviews should use a dedicated reviewer model.

### 4. Customize the UI

`ReviewPanel` in `app.tsx` owns the side-panel experience. It uses vendored shadcn components under `components/ui/` and host theme tokens. Add components with:

```sh
npx shadcn add @bb/select @bb/badge
```

Do not hardcode colors; use classes such as `bg-background`, `border-border`, and `text-muted-foreground`.

### 5. Customize loop fixing

`review-loop` in `server.ts` is a durable state machine:

1. starts an isolated review thread with local changes included;
2. waits for it to become idle;
3. parses P0-P2 findings or the `needs attention` verdict with `review-result.ts`;
4. queues the exact Pi fix prompt in the parent thread and waits for completion;
5. starts another review pass, capped at 10;
6. publishes state changes over `bb.realtime` for the panel.

Loop state lives in namespaced KV rather than module globals, so reloads and server restarts resume it. Change `REVIEW_LOOP_MAX_ITERATIONS` or `REVIEW_LOOP_POLL_MS` in `server.ts` to tune the safety cap or cadence. Parser regression tests live in `review-result.test.ts`.

## Distribution

Before publishing a git/npm install, commit the generated `dist/` artifacts:

```sh
bb plugin build
```

Users can then install from a local path, git, or npm:

```sh
bb plugin install ./bb-plugin-review
bb plugin install git:https://github.com/you/bb-plugin-review.git@main
bb plugin install npm:bb-plugin-review@^0.1.0
```
