import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly as scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";

it("imports only the public BB Plugin SDK", () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const scan = scanPublicSdkOnly(root, { allow: [/^vitest\/config$/u] });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});
