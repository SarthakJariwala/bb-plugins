---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Fan out N parallel visible BB child threads using the providers and models configured for their roles. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not the cloud concurrency limit.
4. Call `pstack_get_model_config` and use the `swarm-workers` role. For a model race, name each arm's configured role or panel selection up front.
5. Give each worker its own writable output when it writes. Use a worktree, branch, or `/tmp/swarm-<slug>/worker-<n>/`.

## Phase B: Fan out

Spawn all N workers in one `pstack_spawn_threads` call with `preset: "general"` and `role: "swarm-workers"`. Use `readOnly: true` for coverage and exploration. Use `workspace: "new-worktree"` for independent repository writers. A batch may contain at most one declared writable worker using `workspace: "reuse"` or `workspace: "project-default"`.

When a worker must start from a non-default branch, name that branch and checkout procedure in its standalone brief.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

Do not wait with a tool. Dependent work waits until BB's child-completion, failure, interruption, or needs-attention messages cover every required worker. A failed or interrupted worker is unresolved unless you replace it. Proceed with N-1 only after an explicit judgment that the missing result is not required, and note the gap.

## Phase C: Aggregate

Read the terminal results. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
