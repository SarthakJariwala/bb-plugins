import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  DEFAULT_KEEPALIVE_TIMING,
  KeepaliveController,
  type KeepaliveStatus,
  type KeepaliveTiming,
} from "./reconciler";
import {
  SpriteTaskClient,
  spriteSocketExists,
  type TaskLease,
} from "./sprite-task-client";
import { scanForActiveWork } from "./work-inventory";

export interface SpriteKeepaliveDependencies {
  createTaskClient?: (taskName: string) => TaskLease;
  detectSprite?: () => Promise<boolean>;
  now?: () => number;
  timing?: Partial<KeepaliveTiming>;
}

function taskNameFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `bb-active-work-${port}`;
  } catch {
    return "bb-active-work-server";
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function inactiveStatus(taskName: string): KeepaliveStatus {
  return {
    spriteDetected: false,
    taskName,
    taskHeld: false,
    activeThreadCount: 0,
    activeThreadIds: [],
    lastSuccessfulScanAt: null,
    lastSuccessfulHeartbeatAt: null,
    lastError: null,
  };
}

function formatStatus(status: KeepaliveStatus): string {
  return [
    `Sprite detected: ${status.spriteDetected ? "yes" : "no"}`,
    `Task: ${status.taskName}`,
    `Task held: ${status.taskHeld ? "yes" : "no"}`,
    `Active threads: ${status.activeThreadCount}`,
    `Active thread IDs: ${status.activeThreadIds.join(", ") || "none"}`,
    `Last successful scan: ${status.lastSuccessfulScanAt ?? "never"}`,
    `Last successful heartbeat: ${
      status.lastSuccessfulHeartbeatAt ?? "never"
    }`,
    `Last error: ${status.lastError ?? "none"}`,
  ].join("\n");
}

export function createSpriteKeepalivePlugin(
  dependencies: SpriteKeepaliveDependencies = {},
) {
  return async function spriteKeepalivePlugin(bb: BbPluginApi): Promise<void> {
    const createTaskClient =
      dependencies.createTaskClient ??
      ((taskName: string) => new SpriteTaskClient(taskName));
    const detectSprite = dependencies.detectSprite ?? spriteSocketExists;
    const timing = { ...DEFAULT_KEEPALIVE_TIMING, ...dependencies.timing };

    let controller: KeepaliveController | null = null;
    let lastStatus = inactiveStatus("bb-active-work-server");
    let reconcilePending = true;

    const requestReconcile = () => {
      reconcilePending = true;
      controller?.requestReconcile();
    };

    for (const event of [
      "thread.created",
      "thread.active",
      "thread.idle",
      "thread.failed",
      "thread.archived",
      "thread.deleted",
    ] as const) {
      bb.events.on(event, requestReconcile);
    }

    bb.background.service("sprite-task-reconciler", {
      async start(signal) {
        const taskName = taskNameFor(bb.server.loopbackBaseUrl);
        lastStatus = inactiveStatus(taskName);

        let detected: boolean;
        try {
          detected = await detectSprite();
        } catch (error) {
          detected = true;
          const detectionError = `Sprite socket detection failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          lastStatus = {
            ...lastStatus,
            spriteDetected: true,
            lastError: detectionError,
          };
          bb.log.warn(detectionError);
        }

        if (!detected) {
          bb.log.info(
            "Plugin inactive: Sprite management socket not found at /.sprite/api.sock",
          );
          await waitForAbort(signal);
          return;
        }

        bb.log.info("Sprite Tasks API detected at /.sprite/api.sock");
        const activeController = new KeepaliveController({
          inventory: (inventorySignal) =>
            scanForActiveWork(bb.sdk.threads, inventorySignal),
          logger: bb.log,
          now: dependencies.now,
          task: createTaskClient(taskName),
          taskName,
          timing,
        });
        controller = activeController;
        if (reconcilePending) activeController.requestReconcile();
        reconcilePending = false;

        const unsubscribe = bb.sdk.subscribe({
          event: "thread:changed",
          callback: requestReconcile,
        });
        try {
          await activeController.run(signal);
        } finally {
          unsubscribe();
          lastStatus = activeController.getStatus();
          if (controller === activeController) controller = null;
        }
      },
    });

    const usage = "Usage: bb sprite-keepalive status [--json]";
    bb.cli.register({
      name: "sprite-keepalive",
      summary: "Inspect the dynamic Sprite keepalive lease",
      commands: [
        {
          name: "status",
          summary: "Show Sprite detection, active work, and lease status",
          usage,
        },
      ],
      async run(argv) {
        const json = argv.includes("--json");
        const args = argv.filter((argument) => argument !== "--json");
        if (
          args.length === 0 ||
          args[0] === "help" ||
          args[0] === "--help"
        ) {
          return { exitCode: 0, stdout: `${usage}\n` };
        }
        if (args.length !== 1 || args[0] !== "status") {
          return { exitCode: 1, stderr: `${usage}\n` };
        }

        const status = controller?.getStatus() ?? lastStatus;
        return {
          exitCode: 0,
          stdout: json
            ? `${JSON.stringify(status)}\n`
            : `${formatStatus(status)}\n`,
        };
      },
    });

    bb.log.info("Sprite Keepalive loaded");
  };
}

export default createSpriteKeepalivePlugin();
