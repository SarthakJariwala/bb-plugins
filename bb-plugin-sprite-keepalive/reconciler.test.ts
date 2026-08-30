import { describe, expect, it, vi } from "vitest";
import { KeepaliveController } from "./reconciler";
import type { TaskLease } from "./sprite-task-client";
import type { WorkInventory } from "./work-inventory";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function harness(initial: WorkInventory = { activeThreadCount: 0, activeThreadIds: [] }) {
  let current = initial;
  let now = 0;
  const task = {
    acquire: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    release: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } satisfies TaskLease;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const inventory = vi.fn(async () => current);
  const controller = new KeepaliveController({
    inventory,
    logger,
    now: () => now,
    task,
    taskName: "bb-active-work-8080",
  });
  return {
    controller,
    inventory,
    logger,
    setInventory(value: WorkInventory) {
      current = value;
    },
    setNow(value: number) {
      now = value;
    },
    task,
  };
}

const active = (ids: string[]): WorkInventory => ({
  activeThreadCount: ids.length,
  activeThreadIds: ids,
});

const signal = () => new AbortController().signal;

describe("KeepaliveController", () => {
  it("acquires one global Task for concurrent active threads", async () => {
    const test = harness(active(["thr_a", "thr_b"]));

    await test.controller.reconcile(signal());

    expect(test.task.acquire).toHaveBeenCalledTimes(1);
    expect(test.controller.getStatus()).toMatchObject({
      activeThreadCount: 2,
      activeThreadIds: ["thr_a", "thr_b"],
      taskHeld: true,
    });
    expect(test.logger.info).toHaveBeenCalledWith(
      "Acquired Sprite keepalive: 2 active BB threads",
    );
  });

  it("keeps the Task while any thread remains active", async () => {
    const test = harness(active(["thr_a", "thr_b"]));
    const abortSignal = signal();
    await test.controller.reconcile(abortSignal);

    test.setInventory(active(["thr_b"]));
    test.setNow(1_000);
    await test.controller.reconcile(abortSignal);

    expect(test.task.release).not.toHaveBeenCalled();
    expect(test.controller.getStatus()).toMatchObject({
      activeThreadCount: 1,
      taskHeld: true,
    });
  });

  it("requires a stable empty scan across the idle release grace", async () => {
    const test = harness(active(["thr_a"]));
    const abortSignal = signal();
    await test.controller.reconcile(abortSignal);

    test.setInventory(active([]));
    await test.controller.reconcile(abortSignal);
    test.setNow(7_499);
    await test.controller.reconcile(abortSignal);
    expect(test.task.release).not.toHaveBeenCalled();

    test.setNow(7_500);
    await test.controller.reconcile(abortSignal);
    expect(test.task.release).toHaveBeenCalledTimes(1);
    expect(test.controller.getStatus().taskHeld).toBe(false);
  });

  it("does not let a stale idle decision delete a reacquired workload", async () => {
    const test = harness(active(["thr_a"]));
    const abortSignal = signal();
    await test.controller.reconcile(abortSignal);

    test.setInventory(active([]));
    await test.controller.reconcile(abortSignal);
    test.setNow(8_000);
    test.setInventory(active(["thr_a"]));
    await test.controller.reconcile(abortSignal);

    expect(test.task.release).not.toHaveBeenCalled();
    expect(test.controller.getStatus().taskHeld).toBe(true);
  });

  it("refreshes after the heartbeat interval without rescanning overlap", async () => {
    const test = harness(active(["thr_a"]));
    const abortSignal = signal();
    await test.controller.reconcile(abortSignal);
    test.setNow(60_000);
    await test.controller.reconcile(abortSignal);

    expect(test.task.acquire).toHaveBeenCalledTimes(2);
    expect(test.controller.getStatus().lastSuccessfulHeartbeatAt).toBe(
      "1970-01-01T00:01:00.000Z",
    );
  });

  it("preserves and refreshes an existing Task when inventory fails", async () => {
    const test = harness(active(["thr_a"]));
    const abortSignal = signal();
    await test.controller.reconcile(abortSignal);

    test.setNow(60_000);
    test.inventory.mockRejectedValueOnce(new Error("database busy"));
    await test.controller.reconcile(abortSignal);

    expect(test.task.acquire).toHaveBeenCalledTimes(2);
    expect(test.task.release).not.toHaveBeenCalled();
    expect(test.controller.getStatus()).toMatchObject({
      lastError: "Thread inventory failed: database busy",
      taskHeld: true,
    });
  });

  it("recovers from a failed initial Task acquisition", async () => {
    const test = harness(active(["thr_a"]));
    test.task.acquire.mockRejectedValueOnce(new Error("socket unavailable"));
    const abortSignal = signal();

    await test.controller.reconcile(abortSignal);
    expect(test.controller.getStatus()).toMatchObject({
      lastError: "Sprite Task refresh failed: socket unavailable",
      taskHeld: false,
    });

    test.setNow(5_000);
    await test.controller.reconcile(abortSignal);
    expect(test.task.acquire).toHaveBeenCalledTimes(2);
    expect(test.controller.getStatus()).toMatchObject({
      lastError: null,
      taskHeld: true,
    });
  });

  it("serializes scans and drains an event received during a scan", async () => {
    const first = deferred<WorkInventory>();
    let concurrent = 0;
    let maxConcurrent = 0;
    const inventory = vi.fn(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (inventory.mock.calls.length === 1) return await first.promise;
        return active(["thr_a"]);
      } finally {
        concurrent -= 1;
      }
    });
    const task: TaskLease = {
      acquire: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new KeepaliveController({
      inventory,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      task,
      taskName: "task",
    });
    const abortSignal = signal();

    const reconciling = controller.reconcile(abortSignal);
    controller.requestReconcile();
    first.resolve(active(["thr_a"]));
    await reconciling;

    expect(inventory).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
    expect(task.acquire).toHaveBeenCalledTimes(1);
  });

  it("best-effort releases the Task when the service aborts", async () => {
    const test = harness(active(["thr_a"]));
    const abort = new AbortController();
    const running = test.controller.run(abort.signal);
    await vi.waitFor(() => expect(test.task.acquire).toHaveBeenCalled());

    abort.abort();
    await running;

    expect(test.task.release).toHaveBeenCalledTimes(1);
    expect(test.controller.getStatus().taskHeld).toBe(false);
  });
});
