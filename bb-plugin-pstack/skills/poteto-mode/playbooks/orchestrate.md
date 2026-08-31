### Orchestrate

**You own the program, never the code. Author briefs, drain the queue, keep the frontier green, decide.** For a whole project handed to one standing coordinator chat: multi-day, many stacked PRs, dozens to hundreds of child threads, the human checking in twice a day instead of every five minutes. One task driven to a predicate is Autonomous run. One ambitious run needing a bespoke workflow is figure-it-out. Route here when the work outlives any single agent. Work one agent could finish inside the session's budget is not a program; measured head-to-head, this playbook's ceremony turned a half-hour 12-unit job into 1 landed unit while a plain agent landed all 12. Below that line, route to Autonomous run.

Ceremony must scale with the program. Every gate below prices in coordinator minutes; on cheap near-identical units, collapse it as each section directs rather than paying list price.

Four rules carry the rest.

- Completions are queue events, not interrupts.
- Every spawn and every resume points to the current standing-orders artifact.
- The brief is the product. A vague brief fails quietly, because a worker cannot ask you a question.
- One owner per scope. While children run, the coordinator only coordinates them or works on a disjoint scope. It never investigates or edits delegated scope unless the brief declares an explicit race. It collects required children before dependent work, review, verification, or finalization. A timeout or interrupted collection is unresolved, and read-only advice never substitutes for required implementation delegation.

Open a todolist with the steps below copied in verbatim. A step you skip stays listed with `skip: <reason>`.

#### Roles and placement

- **Coordinator (this chat).** Frames, authors briefs, drains the inbox, owns the human report, and makes judgment calls. It never authors or edits code: conflicted merges, restacks, and code changes are child-thread tasks. Mechanically landing a verified unit (fast-forward or clean cherry-pick of a worker's commit, then push) is bookkeeping the coordinator may do itself when local git is cheap; queueing finished work behind an idle stacker is how a deadline harvests nothing. Spawn only through `pstack_spawn_threads`, collect through `pstack_collect_threads`, send follow-ups with `bb thread tell`, and leave terminal workers visible for inspection. Use `pstack_finish_threads` only when the user explicitly asks to archive them. State reads and writes go through `scripts/orch/orch.ts` at drain points, one command in and one line out, to conserve context. The orch CLI itself never spawns, waits, or wakes anything.
- **Sub-coordinator.** A durable visible BB child thread, one per track, and only when the program exceeds what one coordinator can drain. A track the coordinator can drain itself needs no middle layer: each nested layer re-pays a full orientation preamble, and a blocking sub-coordinator gives the parent another place to wait. Spawn it with `preset: "poteto-agent"`, `role: "hardest-tasks"`, `readOnly: true`, `workspace: "reuse"`, and keep it unarchived while the track is active. It owns its track's units and boards, authors worker briefs, and spawns its own visible workers and verifiers when `canSpawnChild` permits. It rolls up aggregates at wave boundaries and never forwards raw child reports. Cap in-flight children at what one drain can process, roughly ten, as a rolling window; never as blocking batches, which cost the slowest child of every batch.
- **Worker / verifier.** Always a visible BB child thread. Writers use `workspace: "new-worktree"`; read-only investigators and work that explicitly needs the parent's runtime use `workspace: "reuse"`. Briefs use file, PR, thread, and artifact pointers with compact grounding. They never inline large payloads. Children cannot read the coordinator's thread-storage store, so publish required context at a path or URL their environment can read. Prefer fewer, broader workers and one writer per worktree or branch (principle-separate-before-serializing-shared-state). Run a unit's verifier on a different configured provider or model family from its worker when the available catalogs permit it.

Depth stays at coordinator, track, worker. Author the track decomposition per project (build, landing, and verification are common cuts, not a required shape); hard-coded swarm trees were tried and parked as too rigid.

#### Store layout

Create `orchestrate/<project-slug>/` under `$BB_THREAD_STORAGE`, the coordinator thread's persistent storage directory. Every file has exactly one writer; owners publish facts, readers aggregate at read time. Use `bun scripts/orch/orch.ts` for bookkeeping, written below as `orch`, while its canonical plain TSV and JSON stay readable without the CLI.

- `preferences.md` is the standing-orders register: numbered lines, one constraint each (model policy, stack shape and count, verification bar, forbidden paths, escalation policy). Publish a read-only copy at an artifact path every child can access, and point every spawn and resume to it. Inline only the few unit-critical constraints needed to ground the pointer. Directives decay across resumes, and each dropped one costs a human turn. When you catch yourself restating an instruction, append the line before you act (principle-encode-lessons-in-structure).
- `overview.md` is the durable PR and issue DB. Append; never rewrite wholesale per event.
- `units.tsv` has one row per unit: id, track, state, branch, PR, head SHA, brief path. Update rows in place.
- `frontier.json` is the computed merge frontier, per Stack safety.
- `ledger.tsv` is the verification ledger, per Verification.
- `inbox/` holds completion pointers. `gates.md` parks human gates (question, options, default on no answer) so a completion flood cannot wipe a pending human gate.
- `decisions.tsv` is the trail via the show-me-your-work skill.
- `status.md` is derived from `units.tsv` and `ledger.tsv` at each drain, never hand-maintained; regenerate it from the tables instead of narrating events into it, because hand-churned boards get rewritten on every event and go unreadable.

#### The brief

Your prompts to child threads are your only product, and a sloppy brief compounds into slop across the whole tree. Every spawn carries compact grounding and resolvable artifact pointers; a field you cannot fill is a unit you have not scoped yet.

```
GOAL         one sentence, the outcome, executable by a stranger with no chat access
SCOPE        paths this unit may write; paths it may not; its exclusive worktree or branch
CONTEXT      pointers to files, PRs, child threads, and published reports; compact grounding only
             because large payloads stay in artifacts even when this unit depends on them
ACCEPTANCE   checkable criteria, one per line
VERIFY       exact commands or the control-skill path, plus known gotchas
TIMEBOX      rough cap on runtime; on expiry, return partial findings and stop rather than run on
FORBIDDEN    no gt, no rebase, no force-push, no fixes outside scope, plus unit-specific bans
REPORT       status, branch, head SHA, PRs, verdict, what you actually ran, deviations,
             suggested follow-ups
STANDING     <published preferences.md artifact pointer plus unit-critical constraints>
```

Size the brief to the unit. A one-command unit gets the template collapsed to a paragraph that still names goal, scope, the verify command, and the report shape; a 4KB scaffold around a two-line edit costs more to write and obey than the edit. Every child prompt and every `bb thread tell` follow-up points to the published standing-orders artifact. Never paste a large report or transcript into the brief.

A sub-coordinator brief adds its track boundary and unit list, its spawn budget with the new-worktree default and reuse exceptions, the drain protocol, and the rollup format (per child: name, status, PR, head SHA, verdict, one line; plus track status and frontier delta).

A dependency is a context relay, not just ordering: undeclared upstream context makes the worker guess. Publish upstream reports as artifacts and link them with a compact statement of why they matter. Missing fields are a refuse-to-spawn condition. Audit one sampled worker brief per sub-coordinator per wave, concurrently with the wave it samples, never as a gate in front of it; a failing brief stops that track and fixes the sub-coordinator's instructions, not just the worker, because brief quality decays late in a run. Never resume-chain a brief; respawn fresh with consolidated scope.

#### Steps

1. **Frame.** State the done predicate as something countable ("all 126 units merged, each ledger-verified `unit-test-verified` or better"). Quantify scope: units, rough effort, expected stacks, and the wall-clock budget. If one agent could finish inside that budget, stop here and run Autonomous run instead. Collapsing must not depend on another document being present: it means do the work directly in this session, plain workers where they help, verification inline, landing as you go, and none of the store, register, or pilot machinery below. Schedule landing against the budget: by roughly 70% of it, stop spawning and land what is verified, because finished-but-unlanded work counts as zero. Name the tracks per project. A contested decomposition or one-way door goes through the arena skill before the pilot. Present the framing once; reversible prep proceeds without waiting.
2. **Install the runtime.** Run `orch init`. Open the trail via the show-me-your-work skill, write the standing orders before any spawn, and seed `frontier.json` from existing PRs with `orch frontier set --repo <repo-dir>`.
3. **Pilot.** Push one unit through the whole path: brief, worker, verification, stack entry, ledger row, merge. The pilot exists to falsify the brief template, the verify recipe, and the unit size while that costs one agent instead of fifty. Fix the contract from pilot evidence before any fan-out. Scale the pilot to the unit: on programs of near-identical cheap units, the first unit is the pilot, run as a normal unit with its verify command inline, and fan-out starts the moment it lands. The dedicated pilot pipeline (separate verifier agent, audit gate) is for expensive or novel unit shapes, not for clone-units where a serialized pilot has nothing to falsify.
4. **Scale.** Spawn a rolling window of workers up to the in-flight cap, refilling as children finish; blocking batches pay the slowest child of every batch. Spawn track sub-coordinators only past the one-drain threshold in Roles. Recompute ready work after each drain; relay upstream report pointers and compact grounding into downstream briefs; keep sibling communication upward only. The sampled brief audit runs alongside the wave it samples and stops the next refill on failure, not the current one.
5. **Drain.** Run the queue discipline below at every drain point.
6. **Land.** Landing is continuous, never a terminal phase: integration starts with the first verified unit and runs alongside the remaining waves. On heavy repos the stacker is a standing role from wave one, integrating as units verify; on repos where local git is cheap, the coordinator lands verified units itself per Roles. Keep the frontier green before upper-stack work; Stack safety governs. Advance `frontier.json` only on merge or reported new head SHAs.
7. **Close.** Drain the final inbox, reconcile every spawned child thread ID to a terminal row (done, abandoned, zombie-reconciled), confirm the predicate on the real artifact, confirm every landed PR has a verdict for its current head SHA, audit the trail per show-me-your-work including its cross-model review, encode recurring corrections into `preferences.md` or the brief template. Leave the store intact; it is the postmortem.

#### Queue and drain

- On a child completion report, run `orch inbox push <thread-id> <unit> <status> [--report PATH]` and return to what you were doing. Never deep-review inline; a completion that needs review becomes a verifier unit. Never review a diff inside a drain.
- Drain in batches at four points: the end of a critical section, a track rollup, a frontier watcher wake (arm it with a BB automation and a long heartbeat fallback), and before a human report. Begin each batch with `orch inbox drain`. Arrivals during a drain wait for the next one.
- Critical sections you finish first: authoring a brief, a stack operation, a conflict decision, writing a gate, updating ledger or frontier.
- Each drain classifies every pointer (landed, needs-verify, failed, zombie, noise), writes the resulting rows through `orch unit add`, `orch unit set`, and `orch ledger record`, runs `orch status`, then spawns the next wave in one `pstack_spawn_threads` call.
- Account for every spawned child at its track's rollup: arrived, respawned, or explicitly waived with `allowPartial: true` after its scope is no longer required. A timed-out or interrupted collection is unresolved and gets recollected. Silently redoing a missing child's work hides both the wasted spend and the coverage gap its result existed to close.
- A drain turn ends with the three lines from `orch status`: counts against the states, what changed, gates open. Detail lives in `status.md`; the full reply contract applies at checkpoints and close.

#### Stack safety

- The frontier is a computed object, never narrative. Recompute `frontier.json` from `gt` after every merge and stack mutation because GitHub base refs drift mid-restack while gt tracking is authoritative: ordered PR list, branch names, head SHAs, a generation number, the lowest unmerged PR. Resolve it where gt knows the stack, normally the stacker's clone; a checkout whose gt metadata never saw the submits reports no PRs and the command errors rather than guessing.
- Exactly one stacker per stack may run `gt`, serialized within its stack; record the holder in the standing orders. Restacks run in a dedicated isolated BB worktree; never run them in the coordinator's shared checkout.
- Workers never rebase and never run `gt`. Babysitters follow `playbooks/babysit.md`, one per stack, scoped to one immutable frontier generation; they report conflicts to the stacker rather than restacking.
- PR closes and retargets go through the stacker only; closing a base PR orphans every chain above it. Merges and stack surgery are units with briefs like any other.
- One retro watcher follows merged PRs for reverts, post-merge CI breaks, and orphaned follow-ups.

#### Verification

Scale verification to the unit. When VERIFY is a single cheap command, the worker runs it and reports the output, and the coordinator spot-checks receipts; a dedicated verifier agent (on a different model family than the worker) is for units whose verification is expensive, judgment-laden, or high-blast-radius. A verifier agent whose entire product would be rerunning one command is ceremony, not verification.

Write ledger rows with `orch ledger record`. Check the current PR and head SHA with `orch ledger check`. `ledger.tsv`, one row per verdict, keyed by PR number plus head SHA: `live-ui-verified | unit-test-verified | type-check-only | verifier-blocked | verifier-failed`. CI green is an input to a verdict, not a verdict. Behavioral work needs better than `type-check-only`. `verifier-blocked` is not a pass; respawn when the environment heals. `verifier-failed` gets a fix unit, not a re-verify. A worker may self-report; a verifier overrides it on the same key. A new head SHA voids the row, so re-verify after restack. The ledger answers "was this verified", not memory and not the transcript.

A unit is not done until its output is externalized the moment it lands, never batched to the end of the run: a worker pushes its branch, a verifier writes its ledger row, receipts land in the store. Work that exists only on one VM when that VM dies was never done.

#### Liveness and failure

- Never resume an agent to check on it; a resume restarts an idle agent. Probe read-only: the ledger, `units.tsv`, `gh`, pushed branches, and `bb thread show <thread-id>`. Thread-log modification time is not liveness.
- A silent death gets a synthetic postmortem row in the inbox (unit, failure mode, last evidence, options). Replan on evidence as it arrives; never wait for full quiescence.
- Retry by mode: cap-hit or oom, respawn with smaller scope; network-drop, retry as-is; tool-error, retry on a different model; unknown, retry once. Two retries, then abandon the unit and replan around it.
- A zombie that returns hours late reconciles against the current frontier and ledger before anything is accepted; the world moved while it slept. Salvage unique findings through a fresh unit, never a blind merge.
- When continued spawning would produce garbage tree-wide (bad upstream output, broken acceptance, dead infra), write a stop line at the top of the standing orders, let in-flight work finish, fix the cause, clear it.
- Bound your own infra retries the same way you bound a child's. After a few consecutive tool aborts, stop retrying: write a terminal handoff to durable state (what is done, where it lives, the exact command to resume) and end the run. Hours of retry loops against a dead executor produce nothing a handoff would not.
- After a BB restart, re-read the standing orders and `units.tsv`, recompute the frontier, and inspect every recorded child with `bb thread show`. Reattach active or idle children by thread ID, PR, and branch. Respawn only missing or failed sub-coordinators from the stored brief plus current state, then drain and resume. The dead session's store lock clears itself on the next write; `orch` replaces a lock whose holder pid is gone.

#### Escalation

Reaches the human, batched into the status page rather than per item: irreversible actions (force-push to shared branches, deploys, deletions, closing someone else's PR), genuine product or preference calls no experiment settles, a standing order that contradicts observed reality, a program-level dead end that survived a replan. Park each as a `gates.md` entry before asking, and route work around it.

Never reaches the human: frontier nudges, restack mechanics, retries, CI flake triage, review-thread triage, format fixes, scope the brief already forbids (refuse and continue), and "should I keep going". When in doubt, act and log; deferring is the measured failure mode.

Mid-run discoveries fix only what blocks the frontier. Everything else parks in follow-ups; at this fan-out a small scope leak multiplies into PRs nobody asked for.

**Reply:** at checkpoints and close: the predicate and the count against it from `units.tsv` and `ledger.tsv`, tracks and what each landed, the frontier (PR list plus SHAs), verdicts summary, what was abandoned and why, gates awaiting the human (the only asks), the store path, and the trail path. Numbers from the tables, not narrative. Include PR links.
