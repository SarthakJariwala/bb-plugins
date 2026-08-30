import type { TaskLease } from "./sprite-task-client";
import type { WorkInventory } from "./work-inventory";

export interface KeepaliveStatus {
  spriteDetected: boolean;
  taskName: string;
  taskHeld: boolean;
  activeThreadCount: number;
  activeThreadIds: string[];
  lastSuccessfulScanAt: string | null;
  lastSuccessfulHeartbeatAt: string | null;
  lastError: string | null;
}

export interface KeepaliveLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface KeepaliveTiming {
  errorLogIntervalMs: number;
  heartbeatMs: number;
  idleReleaseGraceMs: number;
  retryInitialMs: number;
  retryMaxMs: number;
}

export const DEFAULT_KEEPALIVE_TIMING: KeepaliveTiming = {
  errorLogIntervalMs: 30_000,
  heartbeatMs: 60_000,
  idleReleaseGraceMs: 7_500,
  retryInitialMs: 5_000,
  retryMaxMs: 30_000,
};

export interface KeepaliveControllerOptions {
  inventory(signal: AbortSignal): Promise<WorkInventory>;
  logger: KeepaliveLogger;
  now?: () => number;
  task: TaskLease;
  taskName: string;
  timing?: Partial<KeepaliveTiming>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class WakeWaiter {
  private pending = false;
  private wakeCurrent: (() => void) | null = null;

  wake(): void {
    this.pending = true;
    this.wakeCurrent?.();
  }

  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    if (this.pending || signal.aborted) {
      this.pending = false;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = () => {
        if (this.wakeCurrent !== settle) return;
        this.wakeCurrent = null;
        this.pending = false;
        if (timer !== null) clearTimeout(timer);
        signal.removeEventListener("abort", settle);
        resolve();
      };

      this.wakeCurrent = settle;
      signal.addEventListener("abort", settle, { once: true });
      if (Number.isFinite(delayMs)) timer = setTimeout(settle, delayMs);
    });
  }
}

export class KeepaliveController {
  private readonly inventory: KeepaliveControllerOptions["inventory"];
  private readonly logger: KeepaliveLogger;
  private readonly now: () => number;
  private readonly task: TaskLease;
  private readonly timing: KeepaliveTiming;
  private readonly waiter = new WakeWaiter();
  private readonly status: KeepaliveStatus;

  private failureCount = 0;
  private idleSince: number | null = null;
  private inFlight: Promise<void> | null = null;
  private lastLoggedError: string | null = null;
  private lastLoggedErrorAt = 0;
  private nextHeartbeatAt: number | null = null;
  private reconcileRequested = false;

  constructor(options: KeepaliveControllerOptions) {
    this.inventory = options.inventory;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.task = options.task;
    this.timing = { ...DEFAULT_KEEPALIVE_TIMING, ...options.timing };
    this.status = {
      spriteDetected: true,
      taskName: options.taskName,
      taskHeld: false,
      activeThreadCount: 0,
      activeThreadIds: [],
      lastSuccessfulScanAt: null,
      lastSuccessfulHeartbeatAt: null,
      lastError: null,
    };
  }

  getStatus(): KeepaliveStatus {
    return {
      ...this.status,
      activeThreadIds: [...this.status.activeThreadIds],
    };
  }

  requestReconcile(): void {
    this.reconcileRequested = true;
    this.waiter.wake();
  }

  async reconcile(signal: AbortSignal): Promise<void> {
    this.reconcileRequested = true;
    if (this.inFlight !== null) return this.inFlight;

    const operation = this.drainReconciliations(signal);
    this.inFlight = operation;
    try {
      await operation;
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
      if (this.reconcileRequested && !signal.aborted) this.waiter.wake();
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    // Internal startup/timer requests do not wake the waiter: a wake is only
    // needed for an event arriving while the loop is asleep.
    this.reconcileRequested = true;
    try {
      while (!signal.aborted) {
        await this.reconcile(signal);
        if (signal.aborted) break;
        await this.waiter.wait(this.nextDelayMs(), signal);
        if (!signal.aborted) this.reconcileRequested = true;
      }
    } finally {
      await this.releaseOnShutdown();
    }
  }

  private async drainReconciliations(signal: AbortSignal): Promise<void> {
    while (this.reconcileRequested && !signal.aborted) {
      this.reconcileRequested = false;
      await this.reconcileOnce(signal);
    }
  }

  private async reconcileOnce(signal: AbortSignal): Promise<void> {
    const now = this.now();
    let inventory: WorkInventory;
    try {
      inventory = await this.inventory(signal);
    } catch (error) {
      if (signal.aborted) return;
      const inventoryError = `Thread inventory failed: ${describeError(error)}`;
      this.recordFailure(inventoryError);

      if (
        this.status.taskHeld &&
        (this.nextHeartbeatAt === null || now >= this.nextHeartbeatAt)
      ) {
        try {
          await this.refreshTask(now, true, signal);
          // The Task is healthy, but the uncertain inventory still requires a
          // retry and must never be interpreted as an empty scan.
          this.status.lastError = inventoryError;
        } catch (refreshError) {
          if (!signal.aborted) {
            this.recordFailure(
              `Sprite Task refresh failed: ${describeError(refreshError)}`,
            );
          }
        }
      }
      return;
    }

    this.status.activeThreadCount = inventory.activeThreadCount;
    this.status.activeThreadIds = [...inventory.activeThreadIds];
    this.status.lastSuccessfulScanAt = new Date(now).toISOString();

    if (inventory.activeThreadCount > 0) {
      this.idleSince = null;
      if (
        !this.status.taskHeld ||
        this.nextHeartbeatAt === null ||
        now >= this.nextHeartbeatAt
      ) {
        try {
          await this.refreshTask(now, this.status.taskHeld, signal);
        } catch (error) {
          if (!signal.aborted) {
            this.recordFailure(
              `Sprite Task refresh failed: ${describeError(error)}`,
            );
          }
          return;
        }
      }
      this.markHealthy();
      return;
    }

    if (!this.status.taskHeld) {
      this.idleSince = null;
      this.markHealthy();
      return;
    }

    if (this.idleSince === null) {
      this.idleSince = now;
      this.markHealthy();
      return;
    }

    if (now - this.idleSince < this.timing.idleReleaseGraceMs) {
      this.markHealthy();
      return;
    }

    try {
      await this.task.release(signal);
      this.status.taskHeld = false;
      this.nextHeartbeatAt = null;
      this.idleSince = null;
      this.markHealthy();
      this.logger.info("Released Sprite keepalive: no active BB work");
    } catch (error) {
      if (!signal.aborted) {
        this.recordFailure(
          `Sprite Task release failed: ${describeError(error)}`,
        );
      }
    }
  }

  private async refreshTask(
    now: number,
    wasHeld: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const previousError = this.status.lastError;
    await this.task.acquire(signal);
    this.status.taskHeld = true;
    this.status.lastSuccessfulHeartbeatAt = new Date(now).toISOString();
    this.nextHeartbeatAt = now + this.timing.heartbeatMs;

    if (!wasHeld) {
      this.logger.info(
        `Acquired Sprite keepalive: ${this.status.activeThreadCount} active BB thread${
          this.status.activeThreadCount === 1 ? "" : "s"
        }`,
      );
    } else if (previousError?.startsWith("Sprite Task")) {
      this.logger.info("Refreshed Sprite keepalive after prior API failure");
    }
  }

  private markHealthy(): void {
    this.failureCount = 0;
    this.status.lastError = null;
  }

  private recordFailure(message: string): void {
    this.failureCount += 1;
    this.status.lastError = message;
    const now = this.now();
    if (
      message !== this.lastLoggedError ||
      now - this.lastLoggedErrorAt >= this.timing.errorLogIntervalMs
    ) {
      this.logger.warn(message);
      this.lastLoggedError = message;
      this.lastLoggedErrorAt = now;
    }
  }

  private nextDelayMs(): number {
    if (this.failureCount > 0) {
      return Math.min(
        this.timing.retryInitialMs * 2 ** (this.failureCount - 1),
        this.timing.retryMaxMs,
      );
    }

    const now = this.now();
    if (this.status.taskHeld && this.status.activeThreadCount === 0) {
      if (this.idleSince === null) return this.timing.idleReleaseGraceMs;
      return Math.max(
        0,
        this.timing.idleReleaseGraceMs - (now - this.idleSince),
      );
    }
    if (this.status.taskHeld && this.nextHeartbeatAt !== null) {
      return Math.max(0, this.nextHeartbeatAt - now);
    }
    return Number.POSITIVE_INFINITY;
  }

  private async releaseOnShutdown(): Promise<void> {
    if (!this.status.taskHeld) return;
    try {
      await this.task.release();
      this.status.taskHeld = false;
      this.nextHeartbeatAt = null;
      this.logger.info("Released Sprite keepalive during plugin shutdown");
    } catch (error) {
      const message = `Sprite Task shutdown cleanup failed; lease will expire: ${describeError(
        error,
      )}`;
      this.status.lastError = message;
      this.logger.warn(message);
    }
  }
}
