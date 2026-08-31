/** @vitest-environment jsdom */
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";

describe("pstack settings app", () => {
  it("registers attribution and model-role settings", async () => {
    const app = await loadPluginApp(() => import("./app"));

    expect(app.settingsSections).toHaveLength(2);
    expect(app.settingsSections[0]).toMatchObject({
      id: "about",
      title: "About pstack",
    });
    expect(app.settingsSections[1]).toMatchObject({
      id: "model-roles",
      title: "Model roles",
      description: "Configure the providers, models, and reasoning levels used by pstack workflows.",
    });

    const about = renderSlot(app.settingsSections[0]!, {});
    expect(about.getByText(/pstack is by Lauren Tan/)).toBeTruthy();
    const upstreamLink = about.getByRole("link", {
      name: "View the original pstack plugin for Cursor",
    });
    expect(upstreamLink.getAttribute("href")).toBe(
      "https://github.com/cursor/plugins/tree/main/pstack",
    );
    about.lifecycle.unmount();
  });
});
