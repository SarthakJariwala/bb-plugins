---
name: review
description: Start a structured code review of uncommitted changes, a base branch diff, a commit, a GitHub pull request, selected paths, or a custom concern. Use when the user asks to review code or invokes /review.
---

# Start a code review

Prefer the Review button in the bb thread header when the user wants the interactive target picker.

When invoked directly as a skill, infer the target from the request and run one of:

```sh
bb review start uncommitted
bb review start branch <base-branch>
bb review start commit <sha>
bb review start pr <number-or-url>
bb review start folder <path...>
bb review start custom <instructions...>
```

The command normally creates an isolated child thread that reuses the current environment. Add `--current` immediately after `start` only when the user explicitly wants the review in the current thread.

Add `--loop` to alternate isolated review and parent-thread fix passes until no P0-P2 findings remain (maximum 10 review passes). Loop fixing is not available for commit reviews:

```sh
bb review start --loop uncommitted
bb review start --loop branch main
```

After starting an isolated review, report its thread ID. Do not duplicate the review yourself. The user can inspect it in the Review side panel. For one-shot reviews they can select **Apply findings**; loop fixing applies findings automatically.

Other commands:

```sh
bb review status
bb review apply
bb review stop
bb review clear
```
