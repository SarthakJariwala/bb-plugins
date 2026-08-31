import { describe, expect, it } from "vitest";
import {
  defaultModelConfig,
  normalizeModelConfig,
  selectionForRole,
  validateCompleteModelConfig,
} from "./model-config";

describe("pstack model configuration", () => {
  it("maps the upstream Grok xhigh roles to GPT-5.6 Sol at xhigh", () => {
    const config = defaultModelConfig();

    expect(config["feature-refactoring"]).toEqual([
      {
        providerId: "pi",
        model: "openai-codex/gpt-5.6-sol",
        reasoningLevel: "xhigh",
      },
    ]);
    expect(config["swarm-workers"]).toEqual([
      {
        providerId: "pi",
        model: "openai-codex/gpt-5.6-sol",
        reasoningLevel: "xhigh",
      },
    ]);
  });

  it("keeps valid saved roles and repairs invalid or missing roles", () => {
    const config = normalizeModelConfig({
      "bug-fix": [{ model: "custom/model", reasoningLevel: "high" }],
      "feature-refactoring": [],
    });

    expect(config["bug-fix"]).toEqual([
      { providerId: "pi", model: "custom/model", reasoningLevel: "high" },
    ]);
    expect(config["feature-refactoring"]).toEqual(
      defaultModelConfig()["feature-refactoring"],
    );
  });

  it("requires one selection for scalar roles and rotates panel selections", () => {
    const config = defaultModelConfig();
    config["bug-fix"] = [
      { providerId: "claude", model: "one", reasoningLevel: "high" },
      { providerId: "codex", model: "two", reasoningLevel: "high" },
    ];
    expect(() => validateCompleteModelConfig(config)).toThrow(
      "Bug fix accepts exactly one model",
    );

    const defaults = defaultModelConfig();
    expect(selectionForRole(defaults, "arena-runners", 5)).toEqual(
      defaults["arena-runners"][1],
    );
  });
});
