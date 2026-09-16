import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";

export { experimental_providerBridge } from "./src/provider-bridge.js";

const hostContract = defineRpcContract({});

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {},
});
