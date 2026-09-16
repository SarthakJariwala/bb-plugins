Use SQLSaber without leaving BB. The plugin registers SQLSaber in the standard provider picker and runs the installed `sqlsaber rpc` command on the selected machine.

## What appears in a thread

SQLSaber assistant text and reasoning stream into BB as they arrive. SQLSaber tools use BB's standard tool rows, including live SQL progress. Query results use a dedicated timeline row with a scrollable table, typed values, null markers, and a count that says when the preview is truncated.

## Session controls

Each BB thread owns one SQLSaber process. Stop interrupts the active query. Release closes the process without creating a false interrupted turn. Steering queues text through SQLSaber's native steering command.

Completed conversations remain resumable. The plugin stores a small provider-session mapping in its own data directory, while SQLSaber keeps the conversation in its normal thread store.

## Honest model controls

SQLSaber 0.77.0 reads its model from machine configuration and does not accept a per-session model over RPC. The BB model picker shows that configured model as one entry instead of offering choices the bridge cannot apply. BB reasoning controls map to SQLSaber's supported thinking levels.

## Safe defaults

The plugin never passes `--allow-dangerous`. SQLSaber keeps its default protection against writes and restricted DDL. The provider accepts text prompts only and rejects unsupported attachments.

SQLSaber 0.77.0 or newer must be installed and configured on the machine that runs the thread. Set `SQLSABER_EXECUTABLE` in the BB host daemon environment when the command is outside `PATH`.
