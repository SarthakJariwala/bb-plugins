import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  experimental_recordProviderChildIo as recordProviderChildIo,
  withoutBridgeRuntimeEnv,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  JsonLineDecoder,
  SQLSABER_PROTOCOL_VERSION,
  SqlSaberProtocolError,
  parseSqlSaberLine,
  type SqlSaberEvent,
  type SqlSaberReady,
  type SqlSaberResponse,
} from "./sqlsaber-protocol.js";

const STARTUP_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 7_000;
const MAX_STDERR_CHARACTERS = 16_384;
const MAX_COMMAND_BYTES = 1024 * 1024;

type ClientState =
  | { kind: "starting" }
  | { kind: "ready"; ready: SqlSaberReady }
  | { kind: "closing" }
  | { kind: "closed" };

interface PendingCommand {
  command: string;
  onSuccess?: () => void;
  resolve(response: SqlSaberResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface SqlSaberRpcCallbacks {
  onEvent(event: SqlSaberEvent): void;
  onUnknown(payload: Record<string, unknown>): void;
  onFatal(error: Error): void;
}

export interface LaunchSqlSaberOptions {
  executable: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  resumeThreadId: string | null;
  recordingThreadId: string;
  signal: AbortSignal;
  callbacks: SqlSaberRpcCallbacks;
}

export class SqlSaberCommandError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class SqlSaberRpcClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #callbacks: SqlSaberRpcCallbacks;
  readonly #abortSignal: AbortSignal;
  readonly #abortListener: () => void;
  readonly #decoder = new JsonLineDecoder();
  readonly #startup = createDeferred<SqlSaberReady>();
  readonly #exit = createDeferred<void>();
  readonly #pending = new Map<string, PendingCommand>();
  #state: ClientState = { kind: "starting" };
  #requestCounter = 0;
  #stderr = "";
  #forceKillTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(options: LaunchSqlSaberOptions) {
    this.#callbacks = options.callbacks;
    this.#abortSignal = options.signal;
    this.#abortListener = () => this.forceTerminate();
    const args = [
      "rpc",
      ...(options.resumeThreadId === null
        ? []
        : ["--thread", options.resumeThreadId]),
    ];
    const env = {
      ...withoutBridgeRuntimeEnv({ ...process.env, ...options.env }),
      NO_COLOR: "1",
    };
    this.#child = spawn(options.executable, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    recordProviderChildIo(this.#child, { threadId: options.recordingThreadId });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.#child.stdout.on("end", () => this.#finishOutput());
    this.#child.stderr.on("data", (chunk: Buffer) => this.#appendStderr(chunk));
    this.#child.stdin.on("error", (cause) => {
      this.#fail(
        new Error(`Could not write to SQLSaber RPC: ${errorMessage(cause)}`),
      );
      this.forceTerminate();
    });
    this.#child.once("error", (cause) => {
      this.#fail(new Error(errorMessage(cause)));
      this.forceTerminate();
    });
    this.#child.once("close", (code, signal) => this.#handleClose(code, signal));
    this.#abortSignal.addEventListener("abort", this.#abortListener, {
      once: true,
    });
    if (this.#abortSignal.aborted) {
      this.forceTerminate();
    }
  }

  static async launch(options: LaunchSqlSaberOptions): Promise<SqlSaberRpcClient> {
    const client = new SqlSaberRpcClient(options);
    const timer = setTimeout(() => {
      client.#fail(new Error("SQLSaber RPC did not become ready within 15 seconds"));
      client.forceTerminate();
    }, STARTUP_TIMEOUT_MS);
    try {
      await client.#startup.promise;
      return client;
    } finally {
      clearTimeout(timer);
    }
  }

  get ready(): SqlSaberReady {
    if (this.#state.kind !== "ready") {
      throw new Error("SQLSaber RPC is not ready");
    }
    return this.#state.ready;
  }

  async command(
    type: string,
    fields: Readonly<Record<string, unknown>> = {},
    timeoutMs = COMMAND_TIMEOUT_MS,
    onSuccess?: () => void,
  ): Promise<SqlSaberResponse> {
    if (this.#state.kind !== "ready") {
      throw new Error("SQLSaber RPC is not accepting commands");
    }
    this.#requestCounter += 1;
    const id = `bb-${this.#requestCounter}`;
    const deferred = createDeferred<SqlSaberResponse>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      deferred.reject(new Error(`SQLSaber ${type} command timed out`));
    }, timeoutMs);
    this.#pending.set(id, {
      command: type,
      ...(onSuccess === undefined ? {} : { onSuccess }),
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer,
    });
    try {
      const payload = JSON.stringify({ ...fields, id, type });
      if (Buffer.byteLength(payload, "utf8") > MAX_COMMAND_BYTES) {
        throw new Error("SQLSaber RPC commands cannot exceed 1 MiB");
      }
      this.#child.stdin.write(`${payload}\n`);
    } catch (cause) {
      clearTimeout(timer);
      this.#pending.delete(id);
      throw new Error(`Could not write to SQLSaber RPC: ${errorMessage(cause)}`);
    }
    const response = await deferred.promise;
    if (!response.success) {
      throw new SqlSaberCommandError(response.command, response.error);
    }
    return response;
  }

  async terminate(): Promise<void> {
    if (this.#state.kind === "closed") {
      return;
    }
    if (this.#state.kind === "ready") {
      const shutdown = this.command("shutdown", {}, SHUTDOWN_TIMEOUT_MS);
      this.#state = { kind: "closing" };
      try {
        await shutdown;
      } catch {
        this.#child.kill("SIGTERM");
      }
    } else {
      this.#state = { kind: "closing" };
      this.#child.kill("SIGTERM");
    }
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), 2_000);
    try {
      await this.#exit.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  forceTerminate(): void {
    if (this.#state.kind === "closed" || this.#state.kind === "closing") {
      return;
    }
    this.#state = { kind: "closing" };
    this.#child.kill("SIGTERM");
    this.#forceKillTimer = setTimeout(() => this.#child.kill("SIGKILL"), 2_000);
    this.#forceKillTimer.unref();
  }

  #receive(chunk: Buffer): void {
    try {
      for (const line of this.#decoder.feed(chunk)) {
        if (line.trim() !== "") {
          this.#handleLine(line);
        }
      }
    } catch (cause) {
      this.#fail(
        cause instanceof Error
          ? cause
          : new SqlSaberProtocolError("Could not decode SQLSaber output"),
      );
      this.forceTerminate();
    }
  }

  #finishOutput(): void {
    try {
      for (const line of this.#decoder.finish()) {
        if (line.trim() !== "") {
          this.#handleLine(line);
        }
      }
    } catch (cause) {
      this.#fail(
        cause instanceof Error
          ? cause
          : new SqlSaberProtocolError("Could not decode SQLSaber output"),
      );
      this.forceTerminate();
    }
  }

  #handleLine(line: string): void {
    const parsed = parseSqlSaberLine(line);
    if (parsed.kind === "unknown") {
      this.#callbacks.onUnknown(parsed.payload);
      return;
    }
    const message = parsed.message;
    if (this.#state.kind === "starting") {
      if (message.type === "ready") {
        if (message.protocolVersion !== SQLSABER_PROTOCOL_VERSION) {
          this.#fail(
            new Error(
              `Unsupported SQLSaber RPC protocol ${message.protocolVersion}; expected ${SQLSABER_PROTOCOL_VERSION}`,
            ),
          );
          this.forceTerminate();
          return;
        }
        this.#state = { kind: "ready", ready: message };
        this.#startup.resolve(message);
        return;
      }
      if (message.type === "response" && !message.success) {
        this.#fail(new Error(message.error));
        this.forceTerminate();
        return;
      }
      this.#fail(new Error(`SQLSaber emitted ${message.type} before ready`));
      this.forceTerminate();
      return;
    }
    if (message.type === "response") {
      if (message.id === undefined) {
        return;
      }
      const id = String(message.id);
      const pending = this.#pending.get(id);
      if (pending === undefined) {
        return;
      }
      if (message.command !== pending.command) {
        const error = new SqlSaberProtocolError(
          `SQLSaber returned ${message.command} for pending ${pending.command} command`,
        );
        this.#fail(error);
        this.forceTerminate();
        return;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      try {
        if (message.success) {
          pending.onSuccess?.();
        }
      } catch (cause) {
        const error =
          cause instanceof Error ? cause : new Error(errorMessage(cause));
        pending.reject(error);
        throw error;
      }
      pending.resolve(message);
      return;
    }
    if (message.type === "ready") {
      this.#fail(new Error("SQLSaber emitted ready more than once"));
      this.forceTerminate();
      return;
    }
    this.#callbacks.onEvent(message);
  }

  #appendStderr(chunk: Buffer): void {
    this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(
      -MAX_STDERR_CHARACTERS,
    );
  }

  #handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    const shouldNotify = this.#state.kind === "ready";
    this.#state = { kind: "closed" };
    this.#abortSignal.removeEventListener("abort", this.#abortListener);
    if (this.#forceKillTimer !== null) {
      clearTimeout(this.#forceKillTimer);
      this.#forceKillTimer = null;
    }
    const suffix = this.#stderr.trim() === "" ? "" : `: ${this.#stderr.trim()}`;
    const reason =
      signal === null
        ? `SQLSaber RPC exited with code ${String(code)}`
        : `SQLSaber RPC exited on ${signal}`;
    const error = new Error(`${reason}${suffix}`);
    this.#startup.reject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#exit.resolve(undefined);
    if (shouldNotify) {
      this.#callbacks.onFatal(error);
    }
  }

  #fail(error: Error): void {
    const wasStarting = this.#state.kind === "starting";
    if (this.#state.kind === "closed") {
      return;
    }
    if (wasStarting) {
      this.#startup.reject(error);
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (!wasStarting && this.#state.kind !== "closing") {
      this.#callbacks.onFatal(error);
    }
  }
}
