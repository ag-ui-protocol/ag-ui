/**
 * AG-UI client for agents served by the community Spring AI integration
 * (`com.ag-ui.community:ag-ui-spring-ai-*`, sources in sdks/community/java/spring).
 */

import { HttpAgent } from "@ag-ui/client";

/**
 * The newest AG-UI version the Spring AI server can parse. The community Java
 * SDK models message `content` as a plain string and rejects a 1.0
 * `ContentPart[]` body with HTTP 400; 0.0.39 is the ceiling that makes the
 * client flatten content to text (non-text parts are dropped with a warning).
 *
 * Remove this override once the Java SDK accepts `ContentPart[]` content.
 */
const SPRING_AI_MAX_PROTOCOL_VERSION = "0.0.39";

export class SpringAiAgent extends HttpAgent {
  public override get maxProtocolVersion(): string {
    return SPRING_AI_MAX_PROTOCOL_VERSION;
  }
}
