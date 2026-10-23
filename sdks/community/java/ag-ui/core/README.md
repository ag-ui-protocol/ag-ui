# ag-ui · core

Core types and protocol primitives for the [AG-UI protocol](https://docs.ag-ui.com).

This module is the foundation of the library. It defines the protocol's data
model and the `Agent` abstraction, and has **no third-party runtime
dependencies** — streaming is expressed with the JDK's
`java.util.concurrent.Flow.Publisher` and serialization is left to a pluggable
`Serializer`.

## What's inside

| Package | Contents |
|---------|----------|
| [`agent`](src/main/java/com/agui/community/core/agent) | The `Agent` functional interface, plus `RunAgentInput` and `Context` describing a single run. |
| [`event`](src/main/java/com/agui/community/core/event) | The `Event` model — a `sealed interface` with one record per event variant, discriminated by `EventType`. |
| [`message`](src/main/java/com/agui/community/core/message) | Conversation messages: `UserMessage`, `AssistantMessage`, `SystemMessage`, `DeveloperMessage`, `ToolMessage`, plus `Role`, `ToolCall`, and `FunctionCall`. |
| [`tool`](src/main/java/com/agui/community/core/tool) | `Tool` and `ToolParameters` describing tools available to an agent. |
| [`serialization`](src/main/java/com/agui/community/core/serialization) | The `Serializer` interface (and `SerializationException`) — the JSON binding seam. The core ships no concrete implementation. |

## The event model

`Event` is a [sealed interface](src/main/java/com/agui/community/core/event/Event.java);
every event is one of a fixed set of records, so you can handle them
exhaustively with a `switch`:

```java
String describe(Event event) {
    return switch (event) {
        case RunStartedEvent e        -> "run started";
        case TextMessageContentEvent e -> "text: " + e.delta();
        case ToolCallStartEvent e      -> "tool call: " + e.toolCallName();
        case RunFinishedEvent e        -> "run finished";
        default                        -> event.type().value();
    };
}
```

Every event carries the common `type()`, `timestamp()`, and `rawEvent()`
fields. See [`EventType`](src/main/java/com/agui/community/core/event/EventType.java)
for the full set of variants (lifecycle, text messages, tool calls, reasoning,
state, activity, and the `RAW` / `CUSTOM` / `META_EVENT` specials).

## Token usage on terminal events

`RunFinishedEvent` and `RunErrorEvent` accept an optional `List<TokenUsage>`,
matching the protocol's `usage` array. Previously these records had no usage
component, so a typed consumer could not retain counts received with a terminal
event. Each entry describes one provider and model; a failed run can report the
usage accrued before its failure.

```java
TokenUsage usage = new TokenUsage(
        "example-provider", "example-model",
        120L, 30L, 150L, 10L, 40L, 20L);

RunFinishedEvent finished = new RunFinishedEvent(
        "thread-1", "run-1", null, null, List.of(usage), null, null);
RunErrorEvent failed = new RunErrorEvent(
        "Model request failed", "ModelError", List.of(usage), null, null);
```

All eight `TokenUsage` fields are optional: `provider`, `model`, `inputTokens`,
`outputTokens`, `totalTokens`, `reasoningTokens`, `cachedInputTokens` and
`cacheWriteInputTokens`. Counts use nullable `Long` values, preserving unknown
counts separately from explicit zero and supporting values above 32 bits.
Constructors reject counts outside `0..9_007_199_254_740_991`, the protocol's
JSON safe-integer range. Reasoning is included in output; cache reads and writes
are disjoint parts of input. Producers supply normalized counts and totals;
these records do not meter model calls or calculate usage.

The original constructors and accessors remain available. Original constructors
leave usage `null`; an explicit empty list remains empty. Supplied lists are
copied and cannot be mutated through an event. The added record component is
part of equality, hashing and the record shape, so code using record patterns
or reflecting over components must account for it.

Core still has no JSON runtime dependency. Its Jackson dependency is test-only:
record-binding tests cover both terminal events, multiple models, partial and
empty usage, omitted usage, zero and large counts. Serializers remain pluggable;
use their optional-field policy to omit `null` values, as the Spring serializer
does. These tests exercise record binding, not provider usage collection or a
complete JSON Schema validator.

## The `Agent` abstraction

```java
@FunctionalInterface
public interface Agent {
    Flow.Publisher<Event> run(RunAgentInput input);
}
```

Each subscription represents one run: the publisher emits the run's events in
order and then completes, or signals `onError` on failure.

## Serialization

`core` does not bind to any JSON library. Implement `Serializer` to plug in
Jackson, Gson, or another library; client and server modules accept a
`Serializer` so the choice stays at the application's edge.

## Dependency

```xml
<dependency>
    <groupId>com.ag-ui.community</groupId>
    <artifactId>java-core</artifactId>
    <version>0.2.0</version>
</dependency>
```

See the [root README](../README.md) for the project overview.
