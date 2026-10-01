# @ag-ui/spring-ai

AG-UI client for agents served by the community [Spring AI](https://spring.io/projects/spring-ai)
integration.

The server side is the community Java SDK in
[`sdks/community/java/spring`](../../../../sdks/community/java/spring)
(`com.ag-ui.community:ag-ui-spring-ai-*` on Maven Central). It adapts a Spring AI
`ChatClient` into an AG-UI agent and streams its events over Server-Sent Events from a
Spring Boot (WebMVC or WebFlux) endpoint. `SpringAiAgent` is an `HttpAgent` that
connects to that endpoint.

## Installation

```bash
npm install @ag-ui/spring-ai
pnpm add @ag-ui/spring-ai
yarn add @ag-ui/spring-ai
```

`@ag-ui/client` and `@ag-ui/core` `>=1.0.0` are peer dependencies.

## Usage

```ts
import { SpringAiAgent } from "@ag-ui/spring-ai";

// The Spring starters serve agents at POST /agent (a single Agent bean) or
// POST /agent/{beanName} (several). Change the prefix with `ag-ui.server.path`.
const agent = new SpringAiAgent({
  url: "http://localhost:8080/agent/agentic_chat",
});

const result = await agent.runAgent({
  tools: [], // frontend tools the model may call
});
```

On the Java side, add `ag-ui-spring-ai-webmvc-boot-starter` (Servlet) or
`ag-ui-spring-ai-spring-boot-starter` (WebFlux) and a Spring AI model starter such as
`spring-ai-starter-model-openai`. See the
[Spring integration README](../../../../sdks/community/java/spring/README.md) for
details.

## Protocol version

`SpringAiAgent` pins `maxProtocolVersion` to `0.0.39` on purpose. The community Java
SDK has not moved to AG-UI 1.0 yet:

- User and tool message `content` must be a string. A 1.0 `ContentPart[]` body is
  rejected with HTTP 400, so the client flattens content to its text parts. **Images,
  audio, video and documents are dropped**, with a console warning.
- `protocolVersion` is not sent on `RunAgentInput`. The server ignores unknown fields,
  so this is only a side effect of the pin.

The pin will be removed once the Java SDK accepts `ContentPart[]` content. Until then,
use a plain `HttpAgent` only if you never send structured content.

## Running the Dojo server

The Dojo's Spring AI integration runs a small Spring Boot app in
[`integrations/community/spring-ai/java/examples`](../java/examples) on port 8027.
It needs Java 17+. Maven comes from the bundled wrapper.

```bash
cd integrations/community/spring-ai/java/examples
# Build against the Spring SDK in this checkout (optional: without it, Maven
# uses the published artifacts)
./mvnw -q -DskipTests -f ../../../../../sdks/community/java/spring/pom.xml install
./mvnw -q -DskipTests package
OPENAI_API_KEY=sk-... java -jar target/spring-ai-dojo-server.jar
```

Or from the repo root, with the Dojo and aimock wired up:

```bash
node apps/dojo/scripts/prep-dojo-everything.js --only dojo,spring-ai
node apps/dojo/scripts/run-dojo-everything.js --only dojo,spring-ai
```

Set `OPENAI_BASE_URL` to point the server at another OpenAI-compatible endpoint.
