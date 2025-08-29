package com.agui.tests

import com.agui.core.types.*
import kotlinx.serialization.json.*
import kotlin.test.*

class EventSerializationTest {

    private val json = AgUiJson

    // ========== Lifecycle Events Tests ==========

    @Test
    fun testRunStartedEventSerialization() {
        val event = RunStartedEvent(
            threadId = "thread_123",
            runId = "run_456",
            timestamp = 1234567890L
        )

        val jsonString = json.encodeToString(BaseEvent.serializer(), event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // Verify the discriminator is present
        assertEquals("RUN_STARTED", jsonObj["type"]?.jsonPrimitive?.content)

        // Verify fields
        assertEquals("thread_123", jsonObj["threadId"]?.jsonPrimitive?.content)
        assertEquals("run_456", jsonObj["runId"]?.jsonPrimitive?.content)
        assertEquals(1234567890L, jsonObj["timestamp"]?.jsonPrimitive?.longOrNull)

        // Verify deserialization
        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is RunStartedEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testRunFinishedEventSerialization() {
        val event = RunFinishedEvent(
            threadId = "thread_123",
            runId = "run_456"
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is RunFinishedEvent)
        assertEquals(event.threadId, decoded.threadId)
        assertEquals(event.runId, decoded.runId)
    }

    @Test
    fun testRunErrorEventSerialization() {
        val event = RunErrorEvent(
            message = "Something went wrong",
            code = "ERR_001"
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("RUN_ERROR", jsonObj["type"]?.jsonPrimitive?.content)
        assertEquals("Something went wrong", jsonObj["message"]?.jsonPrimitive?.content)
        assertEquals("ERR_001", jsonObj["code"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is RunErrorEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testStepEventsSerialization() {
        val startEvent = StepStartedEvent(stepName = "data_processing")
        val finishEvent = StepFinishedEvent(stepName = "data_processing")

        // Test start event
        val startJson = json.encodeToString<BaseEvent>(startEvent)
        val decodedStart = json.decodeFromString<BaseEvent>(startJson)

        assertTrue(decodedStart is StepStartedEvent)
        assertEquals("data_processing", decodedStart.stepName)

        // Test finish event
        val finishJson = json.encodeToString<BaseEvent>(finishEvent)
        val decodedFinish = json.decodeFromString<BaseEvent>(finishJson)

        assertTrue(decodedFinish is StepFinishedEvent)
        assertEquals("data_processing", decodedFinish.stepName)
    }

    // ========== Text Message Events Tests ==========

    @Test
    fun testTextMessageStartEventSerialization() {
        val event = TextMessageStartEvent(
            messageId = "msg_789",
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("TEXT_MESSAGE_START", jsonObj["type"]?.jsonPrimitive?.content)
        assertEquals("msg_789", jsonObj["messageId"]?.jsonPrimitive?.content)
        assertEquals("assistant", jsonObj["role"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is TextMessageStartEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testTextMessageContentEventSerialization() {
        val event = TextMessageContentEvent(
            messageId = "msg_789",
            delta = "Hello, world!"
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is TextMessageContentEvent)
        assertEquals(event.messageId, decoded.messageId)
        assertEquals(event.delta, decoded.delta)
    }

    @Test
    fun testTextMessageContentEmptyDeltaValidation() {
        assertFailsWith<IllegalArgumentException> {
            TextMessageContentEvent(
                messageId = "msg_123",
                delta = ""
            )
        }
    }

    @Test
    fun testTextMessageEndEventSerialization() {
        val event = TextMessageEndEvent(messageId = "msg_789")

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is TextMessageEndEvent)
        assertEquals(event, decoded)
    }

    // ========== Tool Call Events Tests ==========

    @Test
    fun testToolCallStartEventSerialization() {
        val event = ToolCallStartEvent(
            toolCallId = "tool_123",
            toolCallName = "get_weather",
            parentMessageId = "msg_456"
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("TOOL_CALL_START", jsonObj["type"]?.jsonPrimitive?.content)
        assertEquals("tool_123", jsonObj["toolCallId"]?.jsonPrimitive?.content)
        assertEquals("get_weather", jsonObj["toolCallName"]?.jsonPrimitive?.content)
        assertEquals("msg_456", jsonObj["parentMessageId"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is ToolCallStartEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testToolCallArgsEventSerialization() {
        val event = ToolCallArgsEvent(
            toolCallId = "tool_123",
            delta = """{"location": "Paris"}"""
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is ToolCallArgsEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testToolCallEndEventSerialization() {
        val event = ToolCallEndEvent(toolCallId = "tool_123")

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is ToolCallEndEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testToolCallResultEventSerialization() {
        val event = ToolCallResultEvent(
            messageId = "msg_456",
            toolCallId = "tool_789",
            content = "Tool execution result",
            role = "tool",
            timestamp = 1234567890L
        )
        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        
        assertTrue(decoded is ToolCallResultEvent)
        assertEquals(event, decoded)
        assertEquals(EventType.TOOL_CALL_RESULT, decoded.eventType)
        assertEquals("msg_456", decoded.messageId)
        assertEquals("tool_789", decoded.toolCallId)
        assertEquals("Tool execution result", decoded.content)
        assertEquals("tool", decoded.role)
    }

    @Test
    fun testToolCallResultEventMinimalSerialization() {
        val event = ToolCallResultEvent(
            messageId = "msg_123",
            toolCallId = "tool_456",
            content = "result"
        )
        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        
        assertTrue(decoded is ToolCallResultEvent)
        assertEquals(event, decoded)
        assertEquals(EventType.TOOL_CALL_RESULT, decoded.eventType)
        assertNull(decoded.role)
        assertNull(decoded.timestamp)
    }

    // ========== State Management Events Tests ==========

    @Test
    fun testStateSnapshotEventSerialization() {
        val snapshot = buildJsonObject {
            put("user", "john_doe")
            put("preferences", buildJsonObject {
                put("theme", "dark")
                put("language", "en")
            })
        }

        val event = StateSnapshotEvent(snapshot = snapshot)

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is StateSnapshotEvent)
        assertEquals(event.snapshot, decoded.snapshot)
    }

    @Test
    fun testStateDeltaEventSerialization() {
        // Create patches as JsonArray (the format expected by JSON Patch)
        val patches = buildJsonArray {
            addJsonObject {
                put("op", "add")
                put("path", "/user/name")
                put("value", "John Doe")
            }
            addJsonObject {
                put("op", "replace")
                put("path", "/counter")
                put("value", 43)
            }
            addJsonObject {
                put("op", "remove")
                put("path", "/temp")
            }
            addJsonObject {
                put("op", "move")
                put("path", "/foo")
                put("from", "/bar")
            }
        }

        val event = StateDeltaEvent(delta = patches)

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is StateDeltaEvent)
        assertEquals(4, decoded.delta.size)

        // Verify first patch
        val firstPatch = decoded.delta[0].jsonObject
        assertEquals("add", firstPatch["op"]?.jsonPrimitive?.content)
        assertEquals("/user/name", firstPatch["path"]?.jsonPrimitive?.content)
        assertEquals("John Doe", firstPatch["value"]?.jsonPrimitive?.content)
    }

    @Test
    fun testStateDeltaWithJsonNull() {
        val patches = buildJsonArray {
            addJsonObject {
                put("op", "add")
                put("path", "/nullable")
                put("value", JsonNull)
            }
            addJsonObject {
                put("op", "test")
                put("path", "/other")
                put("value", JsonNull)
            }
        }

        val event = StateDeltaEvent(delta = patches)
        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is StateDeltaEvent)
        val patchArray = decoded.delta
        assertEquals(2, patchArray.size)

        patchArray.forEach { patch ->
            assertEquals(JsonNull, patch.jsonObject["value"])
        }
    }

    @Test
    fun testStateDeltaEmptyArray() {
        val event = StateDeltaEvent(delta = buildJsonArray { })

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is StateDeltaEvent)
        assertEquals(0, decoded.delta.size)
    }

    @Test
    fun testMessagesSnapshotEventSerialization() {
        val messages = listOf(
            UserMessage(id = "msg_1", content = "Hello"),
            AssistantMessage(id = "msg_2", content = "Hi there!")
        )

        val event = MessagesSnapshotEvent(messages = messages)

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is MessagesSnapshotEvent)
        assertEquals(2, decoded.messages.size)
    }

    // ========== Special Events Tests ==========

    @Test
    fun testRawEventSerialization() {
        val rawData = buildJsonObject {
            put("customField", "customValue")
            put("nested", buildJsonObject {
                put("data", JsonArray(listOf(JsonPrimitive(1), JsonPrimitive(2))))
            })
        }

        val event = RawEvent(
            event = rawData,
            source = "external_system"
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is RawEvent)
        assertEquals(event.event, decoded.event)
        assertEquals(event.source, decoded.source)
    }

    @Test
    fun testCustomEventSerialization() {
        val customValue = buildJsonObject {
            put("action", "user_clicked")
            put("element", "submit_button")
        }

        val event = CustomEvent(
            name = "ui_interaction",
            value = customValue
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)

        assertTrue(decoded is CustomEvent)
        assertEquals(event.name, decoded.name)
        assertEquals(event.value, decoded.value)
    }

    // ========== Null Handling Tests ==========

    @Test
    fun testNullFieldsNotSerialized() {
        val event = RunErrorEvent(
            message = "Error",
            code = null,
            timestamp = null,
            rawEvent = null
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // With explicitNulls = false, null fields should not be included
        assertFalse(jsonObj.containsKey("code"))
        assertFalse(jsonObj.containsKey("timestamp"))
        assertFalse(jsonObj.containsKey("rawEvent"))
    }

    @Test
    fun testOptionalFieldsWithValues() {
        val rawEvent = buildJsonObject {
            put("original", true)
        }

        val event = TextMessageStartEvent(
            messageId = "msg_123",
            timestamp = 1234567890L,
            rawEvent = rawEvent
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals(1234567890L, jsonObj["timestamp"]?.jsonPrimitive?.longOrNull)
        assertNotNull(jsonObj["rawEvent"])
    }

    // ========== Event List Serialization ==========

    @Test
    fun testEventListSerialization() {
        val events: List<BaseEvent> = listOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "m1"),
            TextMessageContentEvent(messageId = "m1", delta = "Hello"),
            TextMessageEndEvent(messageId = "m1"),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val jsonString = json.encodeToString(events)
        val decoded: List<BaseEvent> = json.decodeFromString(jsonString)

        assertEquals(5, decoded.size)
        assertTrue(decoded[0] is RunStartedEvent)
        assertTrue(decoded[1] is TextMessageStartEvent)
        assertTrue(decoded[2] is TextMessageContentEvent)
        assertTrue(decoded[3] is TextMessageEndEvent)
        assertTrue(decoded[4] is RunFinishedEvent)
    }

    // ========== Thinking Events Tests ==========

    @Test
    fun testThinkingStartEventSerialization() {
        val event = ThinkingStartEvent(
            title = "Analyzing the problem",
            timestamp = 1234567890L
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("THINKING_START", jsonObj["type"]?.jsonPrimitive?.content)
        assertEquals("Analyzing the problem", jsonObj["title"]?.jsonPrimitive?.content)
        assertEquals(1234567890L, jsonObj["timestamp"]?.jsonPrimitive?.long)

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is ThinkingStartEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testThinkingStartEventWithoutTitle() {
        val event = ThinkingStartEvent()

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("THINKING_START", jsonObj["type"]?.jsonPrimitive?.content)
        assertFalse(jsonObj.containsKey("title")) // null title should not be serialized

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is ThinkingStartEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testThinkingEndEventSerialization() {
        val event = ThinkingEndEvent(timestamp = 1234567890L)

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("THINKING_END", jsonObj["type"]?.jsonPrimitive?.content)
        assertEquals(1234567890L, jsonObj["timestamp"]?.jsonPrimitive?.long)

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is ThinkingEndEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testThinkingTextMessageStartEventSerialization() {
        val event = ThinkingTextMessageStartEvent(timestamp = 1234567890L)

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("THINKING_TEXT_MESSAGE_START", jsonObj["type"]?.jsonPrimitive?.content)
        assertEquals(1234567890L, jsonObj["timestamp"]?.jsonPrimitive?.long)

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is ThinkingTextMessageStartEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testThinkingTextMessageContentEventSerialization() {
        val event = ThinkingTextMessageContentEvent(
            delta = "I need to think about this step by step..."
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("THINKING_TEXT_MESSAGE_CONTENT", jsonObj["type"]?.jsonPrimitive?.content)
        assertEquals("I need to think about this step by step...", jsonObj["delta"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is ThinkingTextMessageContentEvent)
        assertEquals(event.delta, decoded.delta)
    }

    @Test
    fun testThinkingTextMessageContentEmptyDeltaValidation() {
        assertFailsWith<IllegalArgumentException> {
            ThinkingTextMessageContentEvent(delta = "")
        }
    }

    @Test
    fun testThinkingTextMessageEndEventSerialization() {
        val event = ThinkingTextMessageEndEvent()

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("THINKING_TEXT_MESSAGE_END", jsonObj["type"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is ThinkingTextMessageEndEvent)
        assertEquals(event, decoded)
    }

    @Test
    fun testThinkingEventsWithRawEvent() {
        val rawEventData = buildJsonObject {
            put("modelProvider", "anthropic")
            put("model", "claude-3.5-sonnet")
            put("thinkingMode", "active")
        }

        val events = listOf(
            ThinkingStartEvent(title = "Problem solving", rawEvent = rawEventData),
            ThinkingTextMessageStartEvent(rawEvent = rawEventData),
            ThinkingTextMessageContentEvent(delta = "Let me analyze...", rawEvent = rawEventData),
            ThinkingTextMessageEndEvent(rawEvent = rawEventData),
            ThinkingEndEvent(rawEvent = rawEventData)
        )

        events.forEach { event ->
            val jsonString = json.encodeToString<BaseEvent>(event)
            val decoded = json.decodeFromString<BaseEvent>(jsonString)
            
            assertEquals(rawEventData, decoded.rawEvent)
            assertEquals("anthropic", decoded.rawEvent?.jsonObject?.get("modelProvider")?.jsonPrimitive?.content)
        }
    }

    // ========== Protocol Compliance Tests ==========

    @Test
    fun testEventDiscriminatorFormat() {
        // Test that each event type produces the correct discriminator
        val testCases = mapOf(
            RunStartedEvent(threadId = "t", runId = "r") to "RUN_STARTED",
            RunFinishedEvent(threadId = "t", runId = "r") to "RUN_FINISHED",
            RunErrorEvent(message = "err") to "RUN_ERROR",
            StepStartedEvent(stepName = "s") to "STEP_STARTED",
            StepFinishedEvent(stepName = "s") to "STEP_FINISHED",
            TextMessageStartEvent(messageId = "m") to "TEXT_MESSAGE_START",
            TextMessageContentEvent(messageId = "m", delta = "d") to "TEXT_MESSAGE_CONTENT",
            TextMessageEndEvent(messageId = "m") to "TEXT_MESSAGE_END",
            ToolCallStartEvent(toolCallId = "t", toolCallName = "n") to "TOOL_CALL_START",
            ToolCallArgsEvent(toolCallId = "t", delta = "{}") to "TOOL_CALL_ARGS",
            ToolCallEndEvent(toolCallId = "t") to "TOOL_CALL_END",
            StateSnapshotEvent(snapshot = JsonNull) to "STATE_SNAPSHOT",
            StateDeltaEvent(delta = buildJsonArray { }) to "STATE_DELTA",  // Changed to JsonArray
            MessagesSnapshotEvent(messages = emptyList()) to "MESSAGES_SNAPSHOT",
            RawEvent(event = JsonNull) to "RAW",
            CustomEvent(name = "n", value = JsonNull) to "CUSTOM",
            // Thinking Events
            ThinkingStartEvent() to "THINKING_START",
            ThinkingEndEvent() to "THINKING_END",
            ThinkingTextMessageStartEvent() to "THINKING_TEXT_MESSAGE_START",
            ThinkingTextMessageContentEvent(delta = "thinking...") to "THINKING_TEXT_MESSAGE_CONTENT",
            ThinkingTextMessageEndEvent() to "THINKING_TEXT_MESSAGE_END"
        )

        testCases.forEach { (event, expectedType) ->
            val jsonString = json.encodeToString<BaseEvent>(event)
            val jsonObj = json.parseToJsonElement(jsonString).jsonObject
            assertEquals(
                expectedType,
                jsonObj["type"]?.jsonPrimitive?.content,
                "Event ${event::class.simpleName} should have discriminator $expectedType"
            )
        }
    }

    @Test
    fun testUnknownEventTypeHandling() {
        // Test that unknown event types are rejected
        val invalidJson = """{"type":"UNKNOWN_EVENT","data":"test"}"""

        assertFailsWith<Exception> {
            json.decodeFromString<BaseEvent>(invalidJson)
        }
    }

    @Test
    fun testForwardCompatibility() {
        // Test that extra fields are ignored
        val jsonWithExtra = """
            {
                "type": "RUN_STARTED",
                "threadId": "t1",
                "runId": "r1",
                "futureField": "ignored",
                "anotherField": 123
            }
        """.trimIndent()

        val decoded = json.decodeFromString<BaseEvent>(jsonWithExtra)
        assertTrue(decoded is RunStartedEvent)
        assertEquals("t1", decoded.threadId)
        assertEquals("r1", decoded.runId)
    }

    // ========== Timestamp Field Tests ==========

    @Test
    fun testEventWithTimestamp() {
        val timestamp = 1234567890123L
        val event = RunStartedEvent(
            threadId = "thread-123",
            runId = "run-456",
            timestamp = timestamp
        )

        val jsonString = json.encodeToString(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject
        
        // Verify timestamp is serialized
        assertNotNull(jsonObj["timestamp"])
        assertEquals(timestamp, jsonObj["timestamp"]?.jsonPrimitive?.long)

        // Verify deserialization
        val decoded = json.decodeFromString<RunStartedEvent>(jsonString)
        assertEquals(timestamp, decoded.timestamp)
    }

    @Test
    fun testEventWithoutTimestamp() {
        val event = TextMessageContentEvent(
            messageId = "msg-123",
            delta = "Hello world"
        )

        val jsonString = json.encodeToString(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject
        
        // Verify timestamp is not included when null
        assertFalse(jsonObj.containsKey("timestamp"))
    }

    @Test
    fun testMultipleEventsWithTimestamps() {
        val baseTime = 1700000000000L
        val events = listOf(
            RunStartedEvent(threadId = "t1", runId = "r1", timestamp = baseTime),
            TextMessageStartEvent(messageId = "m1", timestamp = baseTime + 100),
            TextMessageContentEvent(messageId = "m1", delta = "Test", timestamp = baseTime + 200),
            TextMessageEndEvent(messageId = "m1", timestamp = baseTime + 300),
            RunFinishedEvent(threadId = "t1", runId = "r1", timestamp = baseTime + 400)
        )

        events.forEach { event ->
            val jsonString = json.encodeToString<BaseEvent>(event)
            val decoded = json.decodeFromString<BaseEvent>(jsonString)
            assertEquals(event.timestamp, decoded.timestamp)
        }
    }

    // ========== RawEvent Field Tests ==========

    @Test
    fun testEventWithRawEvent() {
        val rawEventData = buildJsonObject {
            put("originalType", "custom_event")
            put("data", buildJsonObject {
                put("key", "value")
                put("number", 42)
            })
        }

        val event = RunErrorEvent(
            message = "Error occurred",
            code = "ERR_001",
            rawEvent = rawEventData
        )

        val jsonString = json.encodeToString(event)
        val decoded = json.decodeFromString<RunErrorEvent>(jsonString)
        
        assertNotNull(decoded.rawEvent)
        assertEquals(rawEventData, decoded.rawEvent)
        assertEquals("custom_event", decoded.rawEvent?.jsonObject?.get("originalType")?.jsonPrimitive?.content)
    }

    @Test
    fun testRawEventSerializationWithDetails() {
        val innerEvent = buildJsonObject {
            put("type", "unknown_event")
            put("customField", "customValue")
            putJsonArray("tags") {
                add("tag1")
                add("tag2")
            }
        }

        val rawEvent = RawEvent(
            event = innerEvent,
            source = "external-system",
            timestamp = 1234567890L
        )

        val jsonString = json.encodeToString<BaseEvent>(rawEvent)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // Verify all fields are serialized
        assertEquals("RAW", jsonObj["type"]?.jsonPrimitive?.content)
        assertEquals(innerEvent, jsonObj["event"])
        assertEquals("external-system", jsonObj["source"]?.jsonPrimitive?.content)
        assertEquals(1234567890L, jsonObj["timestamp"]?.jsonPrimitive?.long)

        // Verify deserialization
        val decoded = json.decodeFromString<RawEvent>(jsonString)
        assertEquals(innerEvent, decoded.event)
        assertEquals("external-system", decoded.source)
        assertEquals(1234567890L, decoded.timestamp)
    }

    @Test
    fun testRawEventWithNestedRawEvent() {
        val originalRawData = buildJsonObject {
            put("level1", "data")
        }

        val rawEvent = RawEvent(
            event = buildJsonObject {
                put("wrapped", true)
                put("content", "test")
            },
            source = "wrapper",
            rawEvent = originalRawData,
            timestamp = 999999L
        )

        val jsonString = json.encodeToString(rawEvent)
        val decoded = json.decodeFromString<RawEvent>(jsonString)

        assertNotNull(decoded.rawEvent)
        assertEquals(originalRawData, decoded.rawEvent)
        assertEquals("wrapper", decoded.source)
        assertEquals(999999L, decoded.timestamp)
    }

    @Test
    fun testEventsWithBothTimestampAndRawEvent() {
        val timestamp = 1700000000000L
        val rawData = buildJsonObject {
            put("debug", true)
            put("origin", "test-suite")
        }

        val events = listOf(
            StateSnapshotEvent(
                snapshot = buildJsonObject { put("state", "initial") },
                timestamp = timestamp,
                rawEvent = rawData
            ),
            CustomEvent(
                name = "test-event",
                value = JsonPrimitive("test-value"),
                timestamp = timestamp + 1000,
                rawEvent = rawData
            )
        )

        events.forEach { event ->
            val jsonString = json.encodeToString<BaseEvent>(event)
            val decoded = json.decodeFromString<BaseEvent>(jsonString)
            
            assertNotNull(decoded.timestamp)
            assertNotNull(decoded.rawEvent)
            assertEquals(event.timestamp, decoded.timestamp)
            assertEquals(rawData, decoded.rawEvent)
        }
    }

    @Test
    fun testTimestampPrecision() {
        // Test with various timestamp values including edge cases
        val timestamps = listOf(
            0L,                    // Epoch start
            1L,                    // Minimal positive
            999999999999L,         // Milliseconds before year 2001
            1700000000000L,        // Recent timestamp
            9999999999999L,        // Far future
            Long.MAX_VALUE         // Maximum value
        )

        timestamps.forEach { ts ->
            val event = StepStartedEvent(
                stepName = "test-step",
                timestamp = ts
            )
            
            val jsonString = json.encodeToString(event)
            val decoded = json.decodeFromString<StepStartedEvent>(jsonString)
            
            assertEquals(ts, decoded.timestamp, "Timestamp $ts was not preserved correctly")
        }
    }

    // ========== RawEvent Field Tests (for all event types) ==========

    @Test
    fun testRunStartedEventWithRawEvent() {
        val rawEventData = buildJsonObject {
            put("originalSource", "legacy-system")
            put("metadata", buildJsonObject {
                put("version", "1.0")
                put("debugInfo", true)
            })
        }

        val event = RunStartedEvent(
            threadId = "thread-123",
            runId = "run-456",
            timestamp = 1700000000000L,
            rawEvent = rawEventData
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // Verify all fields including rawEvent
        assertEquals("RUN_STARTED", jsonObj["type"]?.jsonPrimitive?.content)
        assertEquals("thread-123", jsonObj["threadId"]?.jsonPrimitive?.content)
        assertEquals("run-456", jsonObj["runId"]?.jsonPrimitive?.content)
        assertEquals(1700000000000L, jsonObj["timestamp"]?.jsonPrimitive?.long)
        assertEquals(rawEventData, jsonObj["rawEvent"])

        // Verify deserialization
        val decoded = json.decodeFromString<RunStartedEvent>(jsonString)
        assertEquals(rawEventData, decoded.rawEvent)
        assertEquals("legacy-system", decoded.rawEvent?.jsonObject?.get("originalSource")?.jsonPrimitive?.content)
    }

    @Test
    fun testTextMessageEventsWithRawEvent() {
        val rawEventData = buildJsonObject {
            put("llmProvider", "openai")
            put("model", "gpt-4")
            put("requestId", "req-12345")
            putJsonObject("usage") {
                put("promptTokens", 150)
                put("completionTokens", 75)
            }
        }

        // Test all three text message event types
        val startEvent = TextMessageStartEvent(
            messageId = "msg-001",
            rawEvent = rawEventData
        )

        val contentEvent = TextMessageContentEvent(
            messageId = "msg-001",
            delta = "Hello, how can I help you?",
            rawEvent = rawEventData
        )

        val endEvent = TextMessageEndEvent(
            messageId = "msg-001",
            rawEvent = rawEventData
        )

        // Verify each event preserves rawEvent
        listOf(startEvent, contentEvent, endEvent).forEach { event ->
            val jsonString = json.encodeToString<BaseEvent>(event)
            val decoded = json.decodeFromString<BaseEvent>(jsonString)
            
            assertNotNull(decoded.rawEvent)
            assertEquals(rawEventData, decoded.rawEvent)
            assertEquals("openai", decoded.rawEvent?.jsonObject?.get("llmProvider")?.jsonPrimitive?.content)
        }
    }

    @Test
    fun testToolCallEventsWithRawEvent() {
        val rawEventData = buildJsonObject {
            put("toolProvider", "internal")
            put("executionTime", 45)
            putJsonArray("capabilities") {
                add("read")
                add("write")
                add("execute")
            }
        }

        val toolCallStart = ToolCallStartEvent(
            toolCallId = "tool-123",
            toolCallName = "file_reader",
            parentMessageId = "msg-parent",
            rawEvent = rawEventData
        )

        val toolCallArgs = ToolCallArgsEvent(
            toolCallId = "tool-123",
            delta = """{"path": "/tmp/test.txt"}""",
            rawEvent = rawEventData
        )

        val toolCallEnd = ToolCallEndEvent(
            toolCallId = "tool-123",
            rawEvent = rawEventData
        )

        // Test serialization and deserialization
        val events = listOf(toolCallStart, toolCallArgs, toolCallEnd)
        events.forEach { event ->
            val jsonString = json.encodeToString<BaseEvent>(event)
            val decoded = json.decodeFromString<BaseEvent>(jsonString)
            
            assertEquals(rawEventData, decoded.rawEvent)
            val capabilities = decoded.rawEvent?.jsonObject?.get("capabilities")?.jsonArray
            assertNotNull(capabilities)
            assertEquals(3, capabilities.size)
            assertEquals("execute", capabilities[2].jsonPrimitive.content)
        }
    }

    @Test
    fun testStateEventsWithRawEvent() {
        val rawEventData = buildJsonObject {
            put("stateVersion", 2)
            put("syncedAt", "2024-01-15T10:30:00Z")
            put("source", "state-manager")
        }

        // StateSnapshotEvent
        val snapshotEvent = StateSnapshotEvent(
            snapshot = buildJsonObject {
                put("currentStep", "processing")
                put("itemsProcessed", 42)
            },
            rawEvent = rawEventData
        )

        // StateDeltaEvent with JSON Patch
        val deltaEvent = StateDeltaEvent(
            delta = buildJsonArray {
                addJsonObject {
                    put("op", "add")
                    put("path", "/itemsProcessed")
                    put("value", 43)
                }
            },
            rawEvent = rawEventData
        )

        // MessagesSnapshotEvent
        val messagesEvent = MessagesSnapshotEvent(
            messages = listOf(
                UserMessage(id = "1", content = "Hello"),
                AssistantMessage(id = "2", content = "Hi there")
            ),
            rawEvent = rawEventData
        )

        listOf(snapshotEvent, deltaEvent, messagesEvent).forEach { event ->
            val jsonString = json.encodeToString<BaseEvent>(event)
            val decoded = json.decodeFromString<BaseEvent>(jsonString)
            
            assertEquals(rawEventData, decoded.rawEvent)
            assertEquals(2, decoded.rawEvent?.jsonObject?.get("stateVersion")?.jsonPrimitive?.int)
        }
    }

    @Test
    fun testRunErrorEventWithComplexRawEvent() {
        val rawEventData = buildJsonObject {
            put("errorContext", buildJsonObject {
                put("file", "processor.kt")
                put("line", 125)
                put("function", "processData")
            })
            putJsonArray("stackTrace") {
                add("at processData(processor.kt:125)")
                add("at main(app.kt:50)")
            }
            put("environment", buildJsonObject {
                put("os", "Linux")
                put("jvm", "17.0.5")
                put("heap", "512MB")
            })
        }

        val errorEvent = RunErrorEvent(
            message = "Failed to process data",
            code = "PROC_ERR_001",
            timestamp = 1700000000000L,
            rawEvent = rawEventData
        )

        val jsonString = json.encodeToString(errorEvent)
        val decoded = json.decodeFromString<RunErrorEvent>(jsonString)

        // Verify complex nested structure is preserved
        assertNotNull(decoded.rawEvent)
        val errorContext = decoded.rawEvent?.jsonObject?.get("errorContext")?.jsonObject
        assertEquals("processor.kt", errorContext?.get("file")?.jsonPrimitive?.content)
        assertEquals(125, errorContext?.get("line")?.jsonPrimitive?.int)
        
        val stackTrace = decoded.rawEvent?.jsonObject?.get("stackTrace")?.jsonArray
        assertEquals(2, stackTrace?.size)
        assertTrue(stackTrace?.get(0)?.jsonPrimitive?.content?.contains("processData") == true)
    }

    @Test
    fun testEventTypeImmutability() {
        // This test verifies that eventType is immutable and tied to the event class
        val runStarted = RunStartedEvent(
            threadId = "t1",
            runId = "r1"
        )
        
        // The eventType is hardcoded in the class, so it will always be RUN_STARTED
        assertEquals(EventType.RUN_STARTED, runStarted.eventType)
        
        // Serialize and verify the type discriminator matches
        val jsonString = json.encodeToString<BaseEvent>(runStarted)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject
        
        // With the @JsonClassDiscriminator, only "type" should be present in the JSON
        assertEquals("RUN_STARTED", jsonObj["type"]?.jsonPrimitive?.content)
        // Ensure eventType field is not in JSON
        assertFalse(jsonObj.containsKey("eventType"))
        
        // When deserializing, the eventType is still correct
        val decoded = json.decodeFromString<RunStartedEvent>(jsonString)
        assertEquals(EventType.RUN_STARTED, decoded.eventType)
    }

    @Test
    fun testCannotCreateEventWithWrongType() {
        // This test documents that you cannot create an event with the wrong type
        // via constructor because eventType is a hardcoded override in each event class
        
        val runFinished = RunFinishedEvent(
            threadId = "t1",
            runId = "r1"
        )
        
        // No matter what, this will always be RUN_FINISHED when constructed
        assertEquals(EventType.RUN_FINISHED, runFinished.eventType)
        
        // Test that the proper JSON with correct type discriminator deserializes correctly
        val properJson = """
            {
                "type": "RUN_FINISHED",
                "threadId": "t1",
                "runId": "r1"
            }
        """.trimIndent()
        
        val decoded = json.decodeFromString<RunFinishedEvent>(properJson)
        assertEquals(EventType.RUN_FINISHED, decoded.eventType)
        
        // Note: With the current implementation, trying to deserialize JSON with a 
        // mismatched type discriminator would fail or produce unexpected results because
        // the serialization framework expects the type to match the class type
    }

    @Test
    fun testNullRawEventNotSerialized() {
        // Test that null rawEvent fields are not included in JSON output
        val event = StepStartedEvent(
            stepName = "initialization",
            timestamp = 1700000000000L,
            rawEvent = null
        )

        val jsonString = json.encodeToString(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // rawEvent should not be present in JSON when null
        assertFalse(jsonObj.containsKey("rawEvent"))
        
        // But other fields should be present
        assertEquals("initialization", jsonObj["stepName"]?.jsonPrimitive?.content)
        assertEquals(1700000000000L, jsonObj["timestamp"]?.jsonPrimitive?.long)
    }

    // ========== Chunk Events Tests ==========

    @Test
    fun testTextMessageChunkEventSerialization() {
        val event = TextMessageChunkEvent(
            messageId = "msg_123",
            delta = "Hello world",
            timestamp = 1234567890L
        )
        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        
        assertTrue(decoded is TextMessageChunkEvent)
        assertEquals(event, decoded)
        assertEquals(EventType.TEXT_MESSAGE_CHUNK, decoded.eventType)
    }

    @Test
    fun testTextMessageChunkEventMinimalSerialization() {
        val event = TextMessageChunkEvent()
        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        
        assertTrue(decoded is TextMessageChunkEvent)
        assertEquals(event, decoded)
        assertNull(decoded.messageId)
        assertNull(decoded.delta)
    }

    @Test
    fun testToolCallChunkEventSerialization() {
        val event = ToolCallChunkEvent(
            toolCallId = "tool_456",
            toolCallName = "calculate",
            delta = "{\"param\":",
            parentMessageId = "msg_parent",
            timestamp = 1234567890L
        )
        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        
        assertTrue(decoded is ToolCallChunkEvent)
        assertEquals(event, decoded)
        assertEquals(EventType.TOOL_CALL_CHUNK, decoded.eventType)
    }

    @Test
    fun testToolCallChunkEventMinimalSerialization() {
        val event = ToolCallChunkEvent()
        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        
        assertTrue(decoded is ToolCallChunkEvent)
        assertEquals(event, decoded)
        assertNull(decoded.toolCallId)
        assertNull(decoded.toolCallName)
        assertNull(decoded.delta)
        assertNull(decoded.parentMessageId)
    }

    @Test
    fun testChunkEventJsonStructure() {
        val textChunk = TextMessageChunkEvent(
            messageId = "msg_123",
            delta = "Hello"
        )
        val jsonString = json.encodeToString<BaseEvent>(textChunk)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject
        
        assertEquals("TEXT_MESSAGE_CHUNK", jsonObj["type"]?.jsonPrimitive?.content)
        assertEquals("msg_123", jsonObj["messageId"]?.jsonPrimitive?.content)
        assertEquals("Hello", jsonObj["delta"]?.jsonPrimitive?.content)
        
        val toolChunk = ToolCallChunkEvent(
            toolCallId = "tool_456",
            toolCallName = "test_tool",
            delta = "args"
        )
        val toolJsonString = json.encodeToString<BaseEvent>(toolChunk)
        val toolJsonObj = json.parseToJsonElement(toolJsonString).jsonObject
        
        assertEquals("TOOL_CALL_CHUNK", toolJsonObj["type"]?.jsonPrimitive?.content)
        assertEquals("tool_456", toolJsonObj["toolCallId"]?.jsonPrimitive?.content)
        assertEquals("test_tool", toolJsonObj["toolCallName"]?.jsonPrimitive?.content)
        assertEquals("args", toolJsonObj["delta"]?.jsonPrimitive?.content)
    }
}