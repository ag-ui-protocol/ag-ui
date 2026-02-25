import { defaultSSEStreamParser } from "./sse";
import { AGUI_MEDIA_TYPE } from "@ag-ui/proto";
import { transformHttpEventStreamFactory } from "./factory";
import { defaultAGUIProtoStreamParser } from "./proto";

/**
 * Transforms HTTP events into BaseEvents using the appropriate format parser based on content type.
 */
export const transformHttpEventStream = transformHttpEventStreamFactory([
  {
    condition: (event) => event.headers.get("content-type") === AGUI_MEDIA_TYPE, parser: defaultAGUIProtoStreamParser
  },
  {
    condition: () => true, parser: defaultSSEStreamParser
  }
]);