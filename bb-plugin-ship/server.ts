import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  SHIP_AS_PR_PROMPT,
  SHIP_PROMPT_SETTING_KEYS,
  SHIP_TO_MAIN_PROMPT,
} from "./prompts";

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    [SHIP_PROMPT_SETTING_KEYS.asPullRequest]: {
      type: "string",
      label: "Ship as PR prompt",
      description: "Text inserted into the composer when you choose Ship as PR.",
      experimental_multiline: true,
      default: SHIP_AS_PR_PROMPT,
    },
    [SHIP_PROMPT_SETTING_KEYS.toMain]: {
      type: "string",
      label: "Ship to main prompt",
      description: "Text inserted into the composer when you choose Ship it to main.",
      experimental_multiline: true,
      default: SHIP_TO_MAIN_PROMPT,
    },
  });

  bb.log.info("loaded");
}
