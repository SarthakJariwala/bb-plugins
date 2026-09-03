# pstack for BB

A BB port of [Cursor's pstack plugin](https://github.com/cursor/plugins/tree/main/pstack), originally by Lauren Tan. It keeps the upstream skills, playbooks, references, scripts, agents, guide, and dormant Benny automation pack as close to upstream as BB permits.

Vendored from upstream pstack `0.14.5` at commit `68836ddaf5697224520f1847d90cdb90ca8babaa`.

## BB adaptations

- Installing the plugin installs all 45 pstack skills through the manifest's `bb.skills` contribution.
- Pstack delegation uses visible BB child threads instead of provider-native subagents. Workers appear under their parent thread while they run and remain available for inspection afterward.
- Each pstack role can use any provider registered in BB, including Pi, Claude, Codex, and Cursor. The plugin supplies tools for batched spawn and cleanup.
- Per-role providers, models, reasoning levels, and service tiers live in plugin storage. Configure them with `/setup-pstack` or under **Settings → Plugins → pstack → Model roles**.
- Upstream Grok `xhigh` defaults become `openai-codex/gpt-5.6-sol` at `xhigh`. The working BB defaults still use GPT-5.6 Sol through Pi, while setup can select any available BB provider and model.
- Cursor transcript, model-rule, cloud-agent, and `/loop` instructions are mapped to BB threads, plugin configuration, managed worktrees, and BB automations.

The upstream `agents/` files remain as source artifacts. `pstack_spawn_threads` implements their BB equivalents through `poteto-agent` and `comment-sicko` presets.

## Install

From this repository collection:

```sh
bb plugin install path:. --plugin pstack
```

Or directly from the plugin directory:

```sh
bb plugin install ./bb-plugin-pstack
```

Then open a new BB thread and run:

```text
/setup-pstack
```

For the normal workflow, start a task with:

```text
/poteto-mode
```

## Configuration

The Settings UI uses the same live provider/model picker as BB's new-thread composer. Scalar roles choose one provider and model. Panel roles launch one child per configured entry.

CLI inspection and reset are also available:

```sh
bb pstack setup
bb pstack config
bb pstack config --json
bb pstack reset
```

## Child-thread tools

Agents receive these native plugin tools:

- `pstack_get_model_config`
- `pstack_update_model_config`
- `pstack_spawn_threads`
- `pstack_finish_threads`

Workers are parented to the calling thread and visible in normal thread navigation. Spawn returns immediately with thread IDs. A batch may contain only one writable worker using a shared `reuse` or `project-default` workspace; additional writers need `new-worktree`. This preflight runs before any child is spawned.

One owner holds each scope. While children run, the parent coordinates them or works on a disjoint scope. It does not investigate or edit delegated scope unless the brief declares an explicit race. After spawn, the parent stops or continues only disjoint work. It does not wait with a tool, `bb thread wait`, or polling. BB posts child-completion, failure, interruption, and needs-attention messages into the parent thread. Those messages are the barrier. Dependent work waits until they cover every required child. If a batched update is status-only, read `bb thread output <id>`. Read-only advice does not satisfy a playbook's mandatory implementation delegation. Briefs point to files and artifacts and keep grounding compact instead of inlining large payloads.

Completed workers stay visible by default. Call `pstack_finish_threads` when the user explicitly requests cleanup.

## Develop

```sh
cd bb-plugin-pstack
npm install
npm test
npm run typecheck
npm run build
bb plugin install .
```

After source changes:

```sh
bb plugin reload pstack
```

Some upstream pstack helper scripts under `skills/poteto-mode/scripts/` require Bun when invoked. They remain vendored with their upstream lockfile.

## License

MIT. See [LICENSE](./LICENSE). Upstream pstack copyright and attribution are preserved.
