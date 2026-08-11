# Ship

A BB plugin that adds a **Ship** dropdown beside the thread-header actions.

The menu drafts one of two prompts in the current thread's composer and focuses it, leaving the user to review it and press Enter:

1. **Ship as PR** — commit changes, test, push, open a pull request, wait for CI, and fix related failures.
2. **Ship it to main** — commit changes, test, and push to `origin/HEAD`.

Both workflows ask the agent to rebase if the remote is ahead, consult the user about substantive conflicts, and archive the thread when complete.

## Develop

```sh
npm install
npm test
npm run typecheck
npm run build
bb plugin install .
```

After source changes:

```sh
bb plugin reload ship
```
