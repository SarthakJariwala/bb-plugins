import { stat } from "node:fs/promises";
import { request } from "node:http";

export const SPRITE_API_SOCKET = "/.sprite/api.sock";
export const DEFAULT_TASK_EXPIRY = "5m";
const MAX_ERROR_BODY_BYTES = 4_096;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export interface TaskLease {
  acquire(signal?: AbortSignal): Promise<void>;
  release(signal?: AbortSignal): Promise<void>;
}

export class SpriteTaskApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "SpriteTaskApiError";
  }
}

export interface SpriteTaskClientOptions {
  expiry?: string;
  requestTimeoutMs?: number;
  socketPath?: string;
}

function abortError(): Error {
  return Object.assign(new Error("Sprite Task request aborted"), {
    name: "AbortError",
  });
}

export class SpriteTaskClient implements TaskLease {
  private readonly expiry: string;
  private readonly requestTimeoutMs: number;
  private readonly socketPath: string;

  constructor(
    readonly taskName: string,
    options: SpriteTaskClientOptions = {},
  ) {
    this.expiry = options.expiry ?? DEFAULT_TASK_EXPIRY;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.socketPath = options.socketPath ?? SPRITE_API_SOCKET;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const body = JSON.stringify({ expire: this.expiry });
    const response = await this.call("PUT", body, signal);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new SpriteTaskApiError(
        this.statusMessage("upsert", response.statusCode, response.body),
        response.statusCode,
      );
    }
  }

  async release(signal?: AbortSignal): Promise<void> {
    const response = await this.call("DELETE", undefined, signal);
    if (
      response.statusCode !== 404 &&
      (response.statusCode < 200 || response.statusCode >= 300)
    ) {
      throw new SpriteTaskApiError(
        this.statusMessage("delete", response.statusCode, response.body),
        response.statusCode,
      );
    }
  }

  private statusMessage(
    operation: string,
    statusCode: number,
    responseBody: string,
  ): string {
    const suffix = responseBody.trim().replace(/\s+/gu, " ");
    return `Sprite Task ${operation} returned HTTP ${statusCode}${
      suffix ? `: ${suffix}` : ""
    }`;
  }

  private call(
    method: "PUT" | "DELETE",
    body: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ body: string; statusCode: number }> {
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        error: Error | null,
        value?: { body: string; statusCode: number },
      ) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value!);
      };
      const onAbort = () => req.destroy(abortError());
      const headers: Record<string, string | number> = {
        Host: "sprite",
      };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(body);
      }

      const req = request(
        {
          headers,
          method,
          path: `/v1/tasks/${encodeURIComponent(this.taskName)}`,
          socketPath: this.socketPath,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let retainedBytes = 0;
          response.on("data", (chunk: Buffer | string) => {
            if (retainedBytes >= MAX_ERROR_BODY_BYTES) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const retained = buffer.subarray(
              0,
              MAX_ERROR_BODY_BYTES - retainedBytes,
            );
            chunks.push(retained);
            retainedBytes += retained.length;
          });
          response.on("end", () => {
            finish(null, {
              body: Buffer.concat(chunks).toString("utf8"),
              statusCode: response.statusCode ?? 0,
            });
          });
          response.on("error", (error) => finish(error));
        },
      );

      req.setTimeout(this.requestTimeoutMs, () => {
        req.destroy(new Error("Sprite Task API request timed out"));
      });
      req.on("error", (error) => finish(error));
      signal?.addEventListener("abort", onAbort, { once: true });
      req.end(body);
    });
  }
}

export async function spriteSocketExists(
  socketPath = SPRITE_API_SOCKET,
): Promise<boolean> {
  try {
    await stat(socketPath);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    // The path exists but cannot be inspected. Treat this as a detected Sprite
    // so API calls retry and expose the actionable error in plugin status.
    return true;
  }
}
