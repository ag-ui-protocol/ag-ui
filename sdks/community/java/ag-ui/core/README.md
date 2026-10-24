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
state, activity, subagents, and the `RAW` / `CUSTOM` / `META_EVENT` specials).

## Subagent lifecycle and attribution

The core previously had no typed subagent lifecycle events, and its output
records could not retain `subagentRunId`. It now models the AG-UI 1.0 events
`SubagentStartedEvent`, `SubagentFinishedEvent`, and `SubagentErrorEvent`.
`subagentRunId` identifies one invocation; `name` can be reused across invocations.
Nested starts can carry `parentSubagentRunId`, `parentToolCallId`, and
`parentMessageId`. A subagent completion or error does not terminate the parent run.

```java
String invocation = "lookup-invocation";
Event started = new SubagentStartedEvent(invocation, "researcher");
Event text = new TextMessageContentEvent("answer-message", "Found a result",
        null, null, invocation);
Event finished = new SubagentFinishedEvent(invocation,
        SubagentFinishedOutcome.success(), Map.of("found", true), null, null);
```

An omitted finish outcome means success. `SubagentFinishedOutcome.suspended()`
ends this stream's segment while allowing the invocation to continue in a later
run. `suspended(List.of("approval-id"))` identifies interrupts owned by that
invocation; absence and an empty list are both valid when a descendant caused
the suspension. The list is copied and cannot be modified through the outcome.
The outcome validates the two wire types (`success` and `suspended`) and rejects
an interrupt list on success. `RunOutcome` describes a different union and is
not used for subagent finishes.

The following 24 existing event records accept an optional `subagentRunId` as
their last constructor component and expose it through `subagentRunId()`:

| Group | Events with attribution |
|-------|-------------------------|
| Text | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `TEXT_MESSAGE_CHUNK` |
| Tools | `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_CHUNK`, `TOOL_CALL_RESULT` |
| Reasoning | `REASONING_START`, `REASONING_END`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT`, `REASONING_MESSAGE_END`, `REASONING_MESSAGE_CHUNK`, `REASONING_ENCRYPTED_VALUE` |
| State | `STATE_SNAPSHOT`, `STATE_DELTA` |
| Activity | `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA` |
| Steps | `STEP_STARTED`, `STEP_FINISHED` |
| Other output | `RAW`, `CUSTOM` |

No attribution means output from the parent agent. Existing constructors remain
available and supply `null` for this new component, preserving their call
signatures. Record component lists, equality, and hash codes now include the
attribution field; code that inspects or deconstructs records must account for
the new shape. Exhaustive handling of `Event` or `EventType` also needs the three
new lifecycle variants.

These models carry caller-supplied protocol data. They do not enforce stream
ordering or execute subagents. Event-level attribution is covered here; message
and interrupt models are not extended by this addition.

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

A serializer that maintains a subtype table must register the three new event
types and omit null optional fields. For an existing Spring `JacksonSerializer`
whose built-in table predates these models, its `ObjectMapper` customization
entry point can supply those registrations:

```java
ObjectMapper mapper = new ObjectMapper();
mapper.registerSubtypes(
        new NamedType(SubagentStartedEvent.class, "SUBAGENT_STARTED"),
        new NamedType(SubagentFinishedEvent.class, "SUBAGENT_FINISHED"),
        new NamedType(SubagentErrorEvent.class, "SUBAGENT_ERROR"));
Serializer serializer = new JacksonSerializer(mapper);
```

This requires a resolved `java-core` containing the new models. Spring adapters
are released separately; their default subtype table is not changed here.
`SubagentFinishedOutcome` is a concrete record with a validated string
discriminator, so it needs no additional polymorphic outcome registration.

Run `mvn -B clean verify` from `sdks/community/java/ag-ui`. Tests cover required
fields, suspension and list ownership, all 24 attribution shapes, absent-field
controls, and JSON round trips through the `Serializer` interface and
`Event.class`. The JSON binding used by core tests is test-only Jackson, with
explicit subtype registrations; it is not a new runtime serializer. Fixtures
follow `docs/spec/1.0/schema.json` and use synthetic data without model calls.

## Dependency

```xml
<dependency>
    <groupId>com.ag-ui.community</groupId>
    <artifactId>java-core</artifactId>
    <version>0.2.0</version>
</dependency>
```

See the [root README](../README.md) for the project overview.
