import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const scriptsDirectory = import.meta.dir;

function currentInstallKey(): string {
  return createHash("sha256")
    .update(readFileSync(join(scriptsDirectory, "package.json")))
    .update("\0")
    .update(readFileSync(join(scriptsDirectory, "bun.lock")))
    .digest("hex");
}

function cacheDirectory(): string {
  const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheRoot, "bb-pstack", "tools", currentInstallKey());
}

function nodePathContains(path: string): boolean {
  return (process.env.NODE_PATH ?? "").split(delimiter).includes(path);
}

export async function ensureDependenciesInstalled(): Promise<void> {
  try {
    import.meta.resolve("commander");
    return;
  } catch {
    // The staged skill has no package parent. Install into the user cache below.
  }

  const installDirectory = cacheDirectory();
  const nodeModulesDirectory = join(installDirectory, "node_modules");
  const commanderPackagePath = join(nodeModulesDirectory, "commander", "package.json");

  if (!existsSync(commanderPackagePath)) {
    await mkdir(installDirectory, { recursive: true });
    await Promise.all([
      copyFile(join(scriptsDirectory, "package.json"), join(installDirectory, "package.json")),
      copyFile(join(scriptsDirectory, "bun.lock"), join(installDirectory, "bun.lock")),
    ]);
    const result = Bun.spawnSync(
      [process.execPath, "install", "--frozen-lockfile", "--production"],
      { cwd: installDirectory },
    );
    if (result.exitCode !== 0) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(
        `bun install --frozen-lockfile --production exited with status ${result.exitCode}`,
      );
    }
    if (!existsSync(commanderPackagePath)) {
      throw new Error("bun install completed without installing commander");
    }
  }

  if (nodePathContains(nodeModulesDirectory)) return;

  const restarted = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_PATH: [nodeModulesDirectory, process.env.NODE_PATH]
        .filter((value): value is string => Boolean(value))
        .join(delimiter),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(restarted.exitCode ?? 1);
}
