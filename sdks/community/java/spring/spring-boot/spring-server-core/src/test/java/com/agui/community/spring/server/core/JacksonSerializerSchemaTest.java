package com.agui.community.spring.server.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.agui.community.core.agent.Context;
import com.agui.community.core.agent.RunAgentInput;
import com.agui.community.core.event.ActivityDeltaEvent;
import com.agui.community.core.event.ActivitySnapshotEvent;
import com.agui.community.core.event.CustomEvent;
import com.agui.community.core.event.Event;
import com.agui.community.core.event.JsonPatchOperation;
import com.agui.community.core.event.MessagesSnapshotEvent;
import com.agui.community.core.event.RawEvent;
import com.agui.community.core.event.ReasoningEncryptedValueEvent;
import com.agui.community.core.event.ReasoningEndEvent;
import com.agui.community.core.event.ReasoningMessageChunkEvent;
import com.agui.community.core.event.ReasoningMessageContentEvent;
import com.agui.community.core.event.ReasoningMessageEndEvent;
import com.agui.community.core.event.ReasoningMessageStartEvent;
import com.agui.community.core.event.ReasoningStartEvent;
import com.agui.community.core.event.RunErrorEvent;
import com.agui.community.core.event.RunFinishedEvent;
import com.agui.community.core.event.RunStartedEvent;
import com.agui.community.core.event.StateDeltaEvent;
import com.agui.community.core.event.StateSnapshotEvent;
import com.agui.community.core.event.StepFinishedEvent;
import com.agui.community.core.event.StepStartedEvent;
import com.agui.community.core.event.TextMessageChunkEvent;
import com.agui.community.core.event.TextMessageContentEvent;
import com.agui.community.core.event.TextMessageEndEvent;
import com.agui.community.core.event.TextMessageStartEvent;
import com.agui.community.core.event.ToolCallArgsEvent;
import com.agui.community.core.event.ToolCallChunkEvent;
import com.agui.community.core.event.ToolCallEndEvent;
import com.agui.community.core.event.ToolCallResultEvent;
import com.agui.community.core.event.ToolCallStartEvent;
import com.agui.community.core.interrupt.Interrupt;
import com.agui.community.core.interrupt.InterruptOutcome;
import com.agui.community.core.interrupt.SuccessOutcome;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.DeveloperMessage;
import com.agui.community.core.message.FunctionCall;
import com.agui.community.core.message.ReasoningMessage;
import com.agui.community.core.message.Role;
import com.agui.community.core.message.SystemMessage;
import com.agui.community.core.message.ToolCall;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;
import com.agui.community.core.tool.Tool;
import com.agui.community.core.tool.ToolParameters;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.dialect.Dialects;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Every event the serializer writes must validate against the canonical AG-UI 1.0 schema
 * ({@code spec/1.0/schema.json}, JSON Schema 2020-12), which the specification names as
 * authoritative for structure. Each event is checked against its own definition
 * ({@code #/$defs/<EventClass>}; the Java class names match the schema's) rather than the
 * 31-way {@code Event} union, so a failure names the offending member instead of every
 * branch that did not match. Surefire runs with the module directory as working
 * directory, so the schema is resolved relative to it.
 */
class JacksonSerializerSchemaTest {

    private static final Path SCHEMA = Path.of("../../../../../../spec/1.0/schema.json");

    private static Schema document;

    private final JacksonSerializer serializer = new JacksonSerializer();

    @BeforeAll
    static void loadSchema() throws IOException {
        assertTrue(Files.exists(SCHEMA), "canonical schema not found at " + SCHEMA.toAbsolutePath().normalize());
        JsonNode schemaNode = new ObjectMapper().readTree(Files.readString(SCHEMA));
        document = SchemaRegistry.withDialect(Dialects.getDraft202012())
                .getSchema(SchemaLocation.of(schemaNode.get("$id").asText()), schemaNode);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("emittedEvents")
    void emittedEventValidatesAgainstItsSchemaDefinition(String name, Event event) {
        Schema definition = document.getRefSchema(
                SchemaLocation.Fragment.of("#/$defs/" + event.getClass().getSimpleName()));
        String json = serializer.serialize(event);

        List<Error> errors = definition.validate(json, InputFormat.JSON);

        assertEquals(List.of(), errors, json);
    }

    static Stream<Arguments> emittedEvents() {
        RunAgentInput input = new RunAgentInput("t1", "r1", Map.of("count", 1),
                List.of(new UserMessage("u1", "hi")),
                List.of(new Tool("get_weather", "Weather",
                        new ToolParameters(Map.of("city", Map.of("type", "string")), List.of("city")))),
                List.of(new Context("locale", "en")), Map.of("k", "v"));
        Interrupt fullInterrupt = new Interrupt("i1", "input_required", "Approve?", "call-1",
                Map.of("type", "object", "properties", Map.of("approved", Map.of("type", "boolean"))),
                "2026-12-31T00:00:00Z", Map.of("toolName", "approve"));
        AssistantMessage assistantWithToolCall = new AssistantMessage("a1", "", null,
                List.of(new ToolCall("c1", new FunctionCall("get_weather", "{}"))));

        return Stream.of(
                Arguments.of("RUN_STARTED minimal", new RunStartedEvent("t1", "r1")),
                Arguments.of("RUN_STARTED with parentRunId, input and timestamp",
                        new RunStartedEvent("t1", "r1", "r0", input, 1700000000000L, null)),
                Arguments.of("RUN_FINISHED minimal", new RunFinishedEvent("t1", "r1")),
                Arguments.of("RUN_FINISHED success outcome and result",
                        new RunFinishedEvent("t1", "r1", new SuccessOutcome(), Map.of("answer", 42), null, null)),
                Arguments.of("RUN_FINISHED interrupt outcome, every interrupt field",
                        new RunFinishedEvent("t1", "r1", new InterruptOutcome(List.of(fullInterrupt)), null, null,
                                null)),
                Arguments.of("RUN_FINISHED interrupt outcome, minimal interrupt",
                        new RunFinishedEvent("t1", "r1",
                                new InterruptOutcome(List.of(new Interrupt("i1", "input_required", "Approve?"))),
                                null, null, null)),
                Arguments.of("RUN_ERROR minimal", new RunErrorEvent("boom")),
                Arguments.of("RUN_ERROR with code", new RunErrorEvent("boom", "E42", null, null)),
                Arguments.of("STEP_STARTED", new StepStartedEvent("plan")),
                Arguments.of("STEP_FINISHED", new StepFinishedEvent("plan")),
                Arguments.of("TEXT_MESSAGE_START", new TextMessageStartEvent("m1", Role.ASSISTANT)),
                Arguments.of("TEXT_MESSAGE_CONTENT", new TextMessageContentEvent("m1", "hello")),
                Arguments.of("TEXT_MESSAGE_END", new TextMessageEndEvent("m1")),
                Arguments.of("TEXT_MESSAGE_CHUNK", new TextMessageChunkEvent("m1", Role.ASSISTANT, "hel")),
                Arguments.of("TOOL_CALL_START minimal", new ToolCallStartEvent("c1", "get_weather")),
                Arguments.of("TOOL_CALL_START with parentMessageId",
                        new ToolCallStartEvent("c1", "get_weather", "m1", null, null)),
                Arguments.of("TOOL_CALL_ARGS", new ToolCallArgsEvent("c1", "{\"city\":")),
                Arguments.of("TOOL_CALL_END", new ToolCallEndEvent("c1")),
                Arguments.of("TOOL_CALL_CHUNK", new ToolCallChunkEvent("c1", "get_weather", "{\"ci")),
                Arguments.of("TOOL_CALL_RESULT minimal", new ToolCallResultEvent("tm1", "c1", "sunny")),
                Arguments.of("TOOL_CALL_RESULT with role",
                        new ToolCallResultEvent("tm1", "c1", "sunny", Role.TOOL, null, null)),
                Arguments.of("REASONING_START", new ReasoningStartEvent("re1")),
                Arguments.of("REASONING_MESSAGE_START", new ReasoningMessageStartEvent("re1")),
                Arguments.of("REASONING_MESSAGE_CONTENT", new ReasoningMessageContentEvent("re1", "thinking")),
                Arguments.of("REASONING_MESSAGE_END", new ReasoningMessageEndEvent("re1")),
                Arguments.of("REASONING_END", new ReasoningEndEvent("re1")),
                Arguments.of("REASONING_MESSAGE_CHUNK", new ReasoningMessageChunkEvent("re1", "thi")),
                Arguments.of("REASONING_ENCRYPTED_VALUE message",
                        new ReasoningEncryptedValueEvent("message", "re1", "ZW5j")),
                Arguments.of("REASONING_ENCRYPTED_VALUE tool-call",
                        new ReasoningEncryptedValueEvent("tool-call", "c1", "ZW5j")),
                Arguments.of("STATE_SNAPSHOT", new StateSnapshotEvent(Map.of("count", 1))),
                Arguments.of("STATE_DELTA add, remove, move, replace", new StateDeltaEvent(List.of(
                        new JsonPatchOperation("add", "/a", 1),
                        new JsonPatchOperation("remove", "/b", null),
                        new JsonPatchOperation("move", "/c", "/d", null),
                        new JsonPatchOperation("replace", "/e", "x")))),
                Arguments.of("STATE_DELTA add, replace and test with a null value", new StateDeltaEvent(List.of(
                        new JsonPatchOperation("add", "/a", null),
                        new JsonPatchOperation("replace", "/b", null),
                        new JsonPatchOperation("test", "/c", null)))),
                Arguments.of("MESSAGES_SNAPSHOT user and assistant text", new MessagesSnapshotEvent(List.of(
                        new UserMessage("u1", "hi", "jeroen"), new AssistantMessage("a1", "hello")))),
                Arguments.of("MESSAGES_SNAPSHOT assistant with tool call",
                        new MessagesSnapshotEvent(List.of(assistantWithToolCall))),
                Arguments.of("MESSAGES_SNAPSHOT system and developer", new MessagesSnapshotEvent(List.of(
                        new SystemMessage("s1", "be nice"), new DeveloperMessage("d1", "dev note")))),
                Arguments.of("MESSAGES_SNAPSHOT tool message",
                        new MessagesSnapshotEvent(List.of(new ToolMessage("tm1", "sunny", "c1")))),
                Arguments.of("MESSAGES_SNAPSHOT tool message with error",
                        new MessagesSnapshotEvent(List.of(new ToolMessage("tm1", "", "c1", "timeout")))),
                Arguments.of("MESSAGES_SNAPSHOT reasoning message",
                        new MessagesSnapshotEvent(List.of(new ReasoningMessage("re1", "thinking")))),
                Arguments.of("ACTIVITY_SNAPSHOT", new ActivitySnapshotEvent("act1", "progress", Map.of("pct", 10))),
                Arguments.of("ACTIVITY_SNAPSHOT replace=false",
                        new ActivitySnapshotEvent("act1", "progress", Map.of("pct", 10), false, null, null)),
                Arguments.of("ACTIVITY_DELTA", new ActivityDeltaEvent("act1", "progress",
                        List.of(new JsonPatchOperation("replace", "/pct", 20)))),
                Arguments.of("RAW minimal", new RawEvent(Map.of("provider", "x"))),
                Arguments.of("RAW with source", new RawEvent(Map.of("provider", "x"), "openai", null, null)),
                Arguments.of("CUSTOM", new CustomEvent("my_event", Map.of("a", 1))));
    }
}
