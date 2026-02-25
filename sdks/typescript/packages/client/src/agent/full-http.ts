import { HttpAgentConfig } from "./types";
import { defaultSSEStreamParser } from "@/transform/sse";
import { defaultAGUIProtoStreamParser } from "@/transform/proto";
import { AGUI_MEDIA_TYPE } from "@ag-ui/encoder";
import { BaseHttpAgent } from "./base-http";

export class HttpAgent extends BaseHttpAgent {
  constructor(config: HttpAgentConfig) {
    super({
      streamHandlers: [
        {
          condition: (event) => event.headers.get("content-type") === AGUI_MEDIA_TYPE,
          parser: defaultAGUIProtoStreamParser
        },
        {
          condition: (event) => event.headers.get("content-type") === "text/event-stream",
          parser: defaultSSEStreamParser
        },
      ] as HttpAgentConfig["streamHandlers"],
      ...config
    });
  }
}