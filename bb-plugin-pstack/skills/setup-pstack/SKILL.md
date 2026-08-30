---
name: setup-pstack
description: Configure which Pi models and reasoning levels pstack uses per role. Detects available Pi models and saves role overrides in the BB pstack plugin. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Configure the pstack plugin's per-role Pi models. The configuration is shared by the plugin's skills and Settings UI. Every delegated worker is a visible BB child thread on the `pi` provider.

## Steps

### 1. Load available models and current state

Call `pstack_get_model_config`. This is the authoritative source for:

- Pi models available in the current thread's environment.
- Supported reasoning levels for each model.
- Current choices for every pstack role.
- Which roles are panels. A panel launches one child thread per entry.

Do not inspect Cursor model slugs or `~/.cursor/rules/pstack-models.mdc`. They are not used by this BB plugin. If Pi model discovery returns an error or no models, report the concrete error and stop without changing configuration.

### 2. Show the current mapping

Present every role with its current model and reasoning level. Mark a selection invalid when its model is absent from the detected catalog or its reasoning level is unsupported.

Group the output into:

- Implementation: feature and refactoring, bug fix, performance issue, hillclimb, hardest tasks.
- Explanation and judgment: judgment and prose, how explorer, how explainer, why investigators, why synthesizer, reflect tooling, reflect judgment.
- Panels: how critics, arena runners, arena cross-judge pool, swarm workers, architect runners, interrogate reviewers.

### 3. Ask for changes

Ask whether to keep the mapping, reset to defaults, or change named roles. Offer only models and reasoning levels returned by `pstack_get_model_config`.

For panel roles, make clear that list length controls fan-out. Preserve the current entry count unless the user asks to change it. `arena cross-judge pool` is a candidate pool; Arena chooses one entry when it judges.

Use a normal concise question. Do not write guessed model IDs.

### 4. Validate and save

Validate each requested model and reasoning pair against the detected catalog. A real model must be present, and its reasoning level must be supported.

Call `pstack_update_model_config` with only the changed roles. For a reset, call it with `reset: true`. Re-read with `pstack_get_model_config` and confirm the saved values.

### 5. Confirm

Tell the user the configuration applies to newly spawned pstack child threads immediately. Existing child threads keep the model they were created with.

Mention the equivalent UI path once: **Settings → Plugins → pstack → Model roles**.

### 6. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof, such as a `verify-*` skill or an existing harness. If not, offer once: "Want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill."

On yes, invoke `/create-verification-skill`. On no, move on without pushing.
