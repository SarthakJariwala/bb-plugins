# Set up pstack

In this page you install the plugin, pick which Pi models pstack uses, and run your first task. Setup is one command plus a short conversation.

## Install the plugin

From the BB plugin collection repository, run:

```sh
bb plugin install path:. --plugin pstack
```

For a direct checkout of this plugin, run `bb plugin install ./bb-plugin-pstack`.

BB confirms that `pstack` is running and imports its skills.

## Pick your models

In a new BB thread, run:

```text
/setup-pstack
```

[`/setup-pstack`](../../skills/setup-pstack/SKILL.md) detects the Pi models available in the thread's environment, shows every role, and asks what you want. Answer the question. The plugin saves the configuration in its own storage, and the same values appear under **Settings → Plugins → pstack → Model roles**.

Scalar roles choose one model and reasoning level. For panel roles, one visible BB child thread runs per entry, so list length sets panel size. Setup also configures `swarm-workers`, the default for `/swarm` unless a race names another configured role or panel arm.

The BB port defaults to `openai-codex/gpt-5.6-sol`. Roles that were Grok `xhigh` upstream remain at `xhigh` reasoning. Judgment and precisely specified hard-work roles default to `max`. Run `/setup-pstack` again whenever you want to change them, or use the Settings UI.

## Accept the verification offer, or don't

At the end of setup, `/setup-pstack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `.bb/skills/verify-<app>/`, a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run `/create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers when it earns its place.

Model changes apply to newly spawned pstack child threads immediately. Existing children keep the model they started with.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. The first item is always "read the Principles section". The rest are the matched playbook's steps copied in, the Feature playbook for this prompt. If `/poteto-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups. `/poteto-mode` is sticky. It stays on for the conversation until you opt out by saying so.

Next: [Route work through `/poteto-mode`](./02-poteto-mode.md).
