/**
 * AG-UI client for agents served by the community Spring AI integration
 * (`com.ag-ui.community:ag-ui-spring-ai-*`, sources in sdks/community/java/spring).
 */

import { HttpAgent } from "@ag-ui/client";

/**
 * The newest AG-UI version the Spring AI server can parse.
 *
 * Deliberately pinned until the community Java SDK gets its 1.0 pass. Its
 * `UserMessage` and `ToolMessage` model `content` as a plain string, so a 1.0
 * `ContentPart[]` body is rejected with HTTP 400 ("Failed to deserialize to
 * RunAgentInput"). Unknown fields such as `protocolVersion` are ignored.
 * 0.0.39 is the only ceiling that turns on the client's content-flattening
 * shim, so it is the newest one this server can accept. The pin also turns on
 * the 0.0.45 and 0.0.57 shims and stops the client sending `protocolVersion`.
 * Neither affects this server: it emits no THINKING_* or SUBAGENT_* events and
 * ignores unknown input fields. Non-text parts (images, audio, documents) are
 * dropped with a warning.
 *
 * Remove this override once the Java SDK accepts `ContentPart[]` content.
 */
const SPRING_AI_MAX_PROTOCOL_VERSION = "0.0.39";

export class SpringAiAgent extends HttpAgent {
  public override get maxProtocolVersion(): string {
    return SPRING_AI_MAX_PROTOCOL_VERSION;
  }
}
