import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SpriteTaskApiError,
  SpriteTaskClient,
  spriteSocketExists,
} from "./sprite-task-client";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function unixServer(
  handler: (request: IncomingMessage, body: string) => { body?: string; status: number },
) {
  const directory = await mkdtemp(join(tmpdir(), "sprite-task-test-"));
  const socketPath = join(directory, "api.sock");
  const requests: Array<{ body: string; method: string | undefined; url: string | undefined }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ body, method: request.method, url: request.url });
      const result = handler(request, body);
      response.statusCode = result.status;
      response.end(result.body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  });
  return { requests, socketPath };
}

describe("SpriteTaskClient", () => {
  it("upserts a five-minute Task and accepts delete 404", async () => {
    const { requests, socketPath } = await unixServer((request) => ({
      status: request.method === "PUT" ? 204 : 404,
    }));
    const client = new SpriteTaskClient("bb-active-work-8080", { socketPath });

    await client.acquire();
    await client.release();

    expect(requests).toEqual([
      {
        body: '{"expire":"5m"}',
        method: "PUT",
        url: "/v1/tasks/bb-active-work-8080",
      },
      {
        body: "",
        method: "DELETE",
        url: "/v1/tasks/bb-active-work-8080",
      },
    ]);
  });

  it("rejects non-success responses with bounded context", async () => {
    const { socketPath } = await unixServer(() => ({
      body: "temporarily unavailable",
      status: 503,
    }));
    const client = new SpriteTaskClient("task", { socketPath });

    await expect(client.acquire()).rejects.toEqual(
      expect.objectContaining<SpriteTaskApiError>({
        message: "Sprite Task upsert returned HTTP 503: temporarily unavailable",
        name: "SpriteTaskApiError",
        statusCode: 503,
      }),
    );
  });

  it("honors an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new SpriteTaskClient("task", {
      socketPath: "/does/not/exist.sock",
    });

    await expect(client.acquire(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("spriteSocketExists", () => {
  it("distinguishes a present socket path from a missing one", async () => {
    const { socketPath } = await unixServer(() => ({ status: 204 }));
    await expect(spriteSocketExists(socketPath)).resolves.toBe(true);
    await expect(spriteSocketExists(`${socketPath}.missing`)).resolves.toBe(false);
  });
});
