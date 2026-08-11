import type { BbPluginApi } from "@bb/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
}
