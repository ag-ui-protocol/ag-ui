package com.agui.client.chunks

import com.agui.client.verify.AGUIError
import com.agui.client.verify.verifyEvents
import com.agui.core.types.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.*

class ChunkTransformTest {
    
    @Test
    fun testTextMessageChunkCreatesNewSequence() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageChunkEvent(
                messageId = "msg1",
                delta = "Hello"
            ),
            TextMessageChunkEvent(
                messageId = "msg1",
                delta = " world"
            )
        )

        val result = events.transformChunks().toList()

        assertEquals(5, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is TextMessageStartEvent)
        assertEquals("msg1", (result[1] as TextMessageStartEvent).messageId)
        assertTrue(result[2] is TextMessageContentEvent)
        assertEquals("Hello", (result[2] as TextMessageContentEvent).delta)
        assertTrue(result[3] is TextMessageContentEvent)
        assertEquals(" world", (result[3] as TextMessageContentEvent).delta)
        assertTrue(result[4] is TextMessageEndEvent)
        assertEquals("msg1", (result[4] as TextMessageEndEvent).messageId)
    }

    @Test
    fun testTextChunkClosesBeforeExplicitStartForDifferentMessage() = runTest {
        val rawEvent = buildJsonObject { put("source", "explicit-start") }
        val metadata = buildJsonObject { put("source", "second-message") }
        for (subagentRunId in listOf(null, "child1")) {
            val explicitStart = TextMessageStartEvent(
                messageId = "msg2",
                name = "writer",
                timestamp = 2L,
                rawEvent = rawEvent,
                metadata = metadata,
                subagentRunId = subagentRunId
            )
            val explicitContent = TextMessageContentEvent(messageId = "msg2", delta = "Second", subagentRunId = subagentRunId)
            val explicitEnd = TextMessageEndEvent(messageId = "msg2", subagentRunId = subagentRunId)
            val result = flowOf(
                TextMessageChunkEvent(messageId = "msg1", delta = "First", subagentRunId = subagentRunId),
                explicitStart,
                explicitContent,
                explicitEnd
            ).transformChunks().toList()

            assertEquals(
                listOf(
                    TextMessageStartEvent(messageId = "msg1", subagentRunId = subagentRunId),
                    TextMessageContentEvent(messageId = "msg1", delta = "First", subagentRunId = subagentRunId),
                    TextMessageEndEvent(
                        messageId = "msg1",
                        timestamp = explicitStart.timestamp,
                        rawEvent = rawEvent,
                        subagentRunId = subagentRunId
                    ),
                    explicitStart,
                    explicitContent,
                    explicitEnd
                ),
                result
            )
            val completeRun = listOf(RunStartedEvent(threadId = "t1", runId = "r1")) +
                result + RunFinishedEvent(threadId = "t1", runId = "r1")
            assertEquals(completeRun, completeRun.asFlow().verifyEvents().toList())
        }
    }

    @Test
    fun testTextChunkRejectsExplicitStartForSameMessage() = runTest {
        for (subagentRunId in listOf(null, "child1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    TextMessageChunkEvent(messageId = "msg1", delta = "First", subagentRunId = subagentRunId),
                    TextMessageStartEvent(messageId = "msg1", subagentRunId = subagentRunId)
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testTextMessageChunkRolePropagation() = runTest {
        val events = flowOf(
            TextMessageChunkEvent(
                messageId = "msg1",
                role = Role.DEVELOPER,
                delta = "Hello"
            )
        )

        val result = events.transformChunks().toList()
        val startEvent = result.first { it is TextMessageStartEvent } as TextMessageStartEvent
        assertEquals(Role.DEVELOPER, startEvent.role)
    }

    @Test
    fun testTextMessageChunkNamePropagation() = runTest {
        val result = flowOf(
            TextMessageChunkEvent(messageId = "msg1", name = "planner", delta = "Hello")
        ).transformChunks().toList()

        val startEvent = result.first { it is TextMessageStartEvent } as TextMessageStartEvent
        assertEquals("planner", startEvent.name)
    }

    @Test
    fun testTextChunkPreservesNameMetadataAndAttribution() = runTest {
        val metadata = buildJsonObject { put("finishReason", "stop") }
        val rawEvent = buildJsonObject { put("source", "text-chunk") }
        val timestamp = 1234567890L
        val result = flowOf(
            TextMessageChunkEvent(
                messageId = "msg1",
                role = Role.ASSISTANT,
                name = "planner",
                delta = "Hello",
                timestamp = timestamp,
                rawEvent = rawEvent,
                metadata = metadata,
                subagentRunId = "sub-1"
            )
        ).transformChunks().toList()

        assertEquals(3, result.size)
        val startEvent = assertIs<TextMessageStartEvent>(result[0])
        assertEquals("planner", startEvent.name)
        assertEquals(metadata, startEvent.metadata)
        assertEquals("sub-1", startEvent.subagentRunId)
        assertEquals(timestamp, startEvent.timestamp)
        assertEquals(rawEvent, startEvent.rawEvent)
        val contentEvent = assertIs<TextMessageContentEvent>(result[1])
        assertEquals("Hello", contentEvent.delta)
        assertEquals(metadata, contentEvent.metadata)
        assertEquals("sub-1", contentEvent.subagentRunId)
        assertEquals(timestamp, contentEvent.timestamp)
        assertEquals(rawEvent, contentEvent.rawEvent)
        val endEvent = assertIs<TextMessageEndEvent>(result[2])
        assertEquals("sub-1", endEvent.subagentRunId)
        assertNull(endEvent.metadata)
        assertNull(endEvent.timestamp)
        assertNull(endEvent.rawEvent)
    }

    @Test
    fun testTextChunkContinuationPreservesEachChunksMetadata() = runTest {
        val openerMetadata = buildJsonObject { put("source", "opener") }
        val firstMetadata = buildJsonObject { put("source", "first-continuation") }
        val secondMetadata = buildJsonObject { put("source", "second-continuation") }
        val firstRawEvent = buildJsonObject { put("sequence", 1) }
        val secondRawEvent = buildJsonObject { put("sequence", 2) }
        val result = flowOf(
            TextMessageChunkEvent(messageId = "msg1", delta = "Hello", metadata = openerMetadata),
            TextMessageChunkEvent(
                delta = " world",
                timestamp = 1L,
                rawEvent = firstRawEvent,
                metadata = firstMetadata
            ),
            TextMessageChunkEvent(
                delta = "!",
                timestamp = 2L,
                rawEvent = secondRawEvent,
                metadata = secondMetadata
            ),
            TextMessageChunkEvent(delta = " Goodbye")
        ).transformChunks().toList()

        assertEquals(
            listOf(
                TextMessageStartEvent(messageId = "msg1", metadata = openerMetadata),
                TextMessageContentEvent(messageId = "msg1", delta = "Hello", metadata = openerMetadata),
                TextMessageContentEvent(
                    messageId = "msg1",
                    delta = " world",
                    timestamp = 1L,
                    rawEvent = firstRawEvent,
                    metadata = firstMetadata
                ),
                TextMessageContentEvent(
                    messageId = "msg1",
                    delta = "!",
                    timestamp = 2L,
                    rawEvent = secondRawEvent,
                    metadata = secondMetadata
                ),
                TextMessageContentEvent(messageId = "msg1", delta = " Goodbye"),
                TextMessageEndEvent(messageId = "msg1")
            ),
            result
        )
    }

    @Test
    fun testTextMetadataOnlyContinuationEmitsEmptyContent() = runTest {
        val rawEvent = buildJsonObject { put("source", "metadata-only-chunk") }
        val metadataValues = listOf(
            buildJsonObject { put("finishReason", "stop") },
            buildJsonObject {}
        )
        for (delta in listOf(null, "")) {
            for (metadata in metadataValues) {
                val result = flowOf(
                    TextMessageChunkEvent(messageId = "msg1", delta = "Hello", subagentRunId = "sub-1"),
                    TextMessageChunkEvent(delta = delta, timestamp = 2L, rawEvent = rawEvent, metadata = metadata)
                ).transformChunks().toList()

                assertEquals(
                    listOf(
                        TextMessageStartEvent(messageId = "msg1", subagentRunId = "sub-1"),
                        TextMessageContentEvent(messageId = "msg1", delta = "Hello", subagentRunId = "sub-1"),
                        TextMessageContentEvent(
                            messageId = "msg1",
                            delta = "",
                            timestamp = 2L,
                            rawEvent = rawEvent,
                            metadata = metadata,
                            subagentRunId = "sub-1"
                        ),
                        TextMessageEndEvent(messageId = "msg1", subagentRunId = "sub-1")
                    ),
                    result
                )
            }
        }
    }

    @Test
    fun testTextMetadataOnlyOpenerEmitsEmptyContent() = runTest {
        val metadata = buildJsonObject { put("finishReason", "stop") }
        for (delta in listOf(null, "")) {
            val result = flowOf(
                TextMessageChunkEvent(messageId = "msg1", delta = delta, metadata = metadata)
            ).transformChunks().toList()

            assertEquals(
                listOf(
                    TextMessageStartEvent(messageId = "msg1", metadata = metadata),
                    TextMessageContentEvent(messageId = "msg1", delta = "", metadata = metadata),
                    TextMessageEndEvent(messageId = "msg1")
                ),
                result
            )
        }
    }

    @Test
    fun testTextChunksWithoutDeltaOrMetadataEmitNoContent() = runTest {
        for (delta in listOf(null, "")) {
            val result = flowOf(
                TextMessageChunkEvent(messageId = "msg1", delta = delta),
                TextMessageChunkEvent(delta = delta)
            ).transformChunks().toList()

            assertEquals(
                listOf(
                    TextMessageStartEvent(messageId = "msg1"),
                    TextMessageEndEvent(messageId = "msg1")
                ),
                result
            )
        }
    }

    @Test
    fun testChunkContinuationRejectsConflictingRepeatedName() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                TextMessageChunkEvent(
                    messageId = "msg1",
                    role = Role.ASSISTANT,
                    name = "planner",
                    delta = "Hello"
                ),
                TextMessageChunkEvent(
                    messageId = "msg1",
                    name = "writer",
                    delta = " world"
                )
            ).transformChunks().toList()
        }
    }

    @Test
    fun testChunkContinuationAcceptsEqualAndOmittedIdentity() = runTest {
        val result = flowOf(
            TextMessageChunkEvent(messageId = "msg1", role = Role.DEVELOPER, name = "planner", delta = "Hello"),
            TextMessageChunkEvent(messageId = "msg1", role = Role.DEVELOPER, name = "planner", delta = " world"),
            TextMessageChunkEvent(delta = "!")
        ).transformChunks().toList()

        assertEquals(
            listOf(
                TextMessageStartEvent(messageId = "msg1", role = Role.DEVELOPER, name = "planner"),
                TextMessageContentEvent(messageId = "msg1", delta = "Hello"),
                TextMessageContentEvent(messageId = "msg1", delta = " world"),
                TextMessageContentEvent(messageId = "msg1", delta = "!"),
                TextMessageEndEvent(messageId = "msg1")
            ),
            result
        )
    }

    @Test
    fun testChunkContinuationAcceptsExplicitDefaultRole() = runTest {
        val result = flowOf(
            TextMessageChunkEvent(messageId = "msg1", delta = "Hello"),
            TextMessageChunkEvent(role = Role.ASSISTANT, delta = " world")
        ).transformChunks().toList()

        assertEquals(
            listOf(
                TextMessageStartEvent(messageId = "msg1", role = Role.ASSISTANT),
                TextMessageContentEvent(messageId = "msg1", delta = "Hello"),
                TextMessageContentEvent(messageId = "msg1", delta = " world"),
                TextMessageEndEvent(messageId = "msg1")
            ),
            result
        )
    }

    @Test
    fun testChunkContinuationRejectsNameAfterUnnamedOpener() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                TextMessageChunkEvent(messageId = "msg1", delta = "Hello"),
                TextMessageChunkEvent(name = "planner", delta = " world")
            ).transformChunks().toList()
        }
    }

    @Test
    fun testChunkContinuationRejectsRoleAfterDefaultRoleOpener() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                TextMessageChunkEvent(messageId = "msg1", delta = "Hello"),
                TextMessageChunkEvent(role = Role.DEVELOPER, delta = " world")
            ).transformChunks().toList()
        }
    }

    @Test
    fun testChunkContinuationRejectsConflictingRepeatedRole() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                TextMessageChunkEvent(messageId = "msg1", role = Role.DEVELOPER, delta = "Hello"),
                TextMessageChunkEvent(role = Role.ASSISTANT, delta = " world")
            ).transformChunks().toList()
        }
    }

    @Test
    fun testTextChunkRejectsExplicitOpenerEvenWithMatchingIdentity() = runTest {
        for (messageId in listOf(null, "msg1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    TextMessageStartEvent(messageId = "msg1", role = Role.DEVELOPER, name = "planner"),
                    TextMessageChunkEvent(messageId = messageId, role = Role.DEVELOPER, name = "planner", delta = "Hello")
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testTextChunkAttributionIsInheritedByGeneratedEvents() = runTest {
        val result = flowOf(
            TextMessageChunkEvent(messageId = "msg1", delta = "Hello", subagentRunId = "child1"),
            TextMessageChunkEvent(delta = " world", subagentRunId = "child1"),
            TextMessageChunkEvent(delta = "!")
        ).transformChunks().toList()

        assertEquals(
            listOf(
                TextMessageStartEvent(messageId = "msg1", subagentRunId = "child1"),
                TextMessageContentEvent(messageId = "msg1", delta = "Hello", subagentRunId = "child1"),
                TextMessageContentEvent(messageId = "msg1", delta = " world", subagentRunId = "child1"),
                TextMessageContentEvent(messageId = "msg1", delta = "!", subagentRunId = "child1"),
                TextMessageEndEvent(messageId = "msg1", subagentRunId = "child1")
            ),
            result
        )
    }

    @Test
    fun testTextChunkContinuationRejectsConflictingAttribution() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                TextMessageChunkEvent(messageId = "msg1", delta = "Hello", subagentRunId = "child1"),
                TextMessageChunkEvent(delta = " world", subagentRunId = "child2")
            ).transformChunks().toList()
        }
    }

    @Test
    fun testTextChunkContinuationRejectsAttributionAfterParentOpener() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                TextMessageChunkEvent(messageId = "msg1", delta = "Hello"),
                TextMessageChunkEvent(delta = " world", subagentRunId = "child1")
            ).transformChunks().toList()
        }
    }

    @Test
    fun testTextChunkEndKeepsOpenerAttributionWhenRunFinishes() = runTest {
        val closingRawEvent = buildJsonObject { put("source", "run-finished") }
        val closingEvent = RunFinishedEvent(
            threadId = "t1",
            runId = "r1",
            timestamp = 1234567891L,
            rawEvent = closingRawEvent,
            metadata = buildJsonObject { put("source", "run-finished") }
        )
        for (subagentRunId in listOf(null, "child1")) {
            val result = flowOf(
                TextMessageChunkEvent(messageId = "msg1", delta = "Hello", subagentRunId = subagentRunId),
                closingEvent
            ).transformChunks().toList()

            assertEquals(
                listOf(
                    TextMessageStartEvent(messageId = "msg1", subagentRunId = subagentRunId),
                    TextMessageContentEvent(messageId = "msg1", delta = "Hello", subagentRunId = subagentRunId),
                    TextMessageEndEvent(
                        messageId = "msg1",
                        timestamp = closingEvent.timestamp,
                        rawEvent = closingRawEvent,
                        metadata = null,
                        subagentRunId = subagentRunId
                    ),
                    closingEvent
                ),
                result
            )
        }
    }

    @Test
    fun testTextChunkRejectsExplicitOpenerEvenWithMatchingAttribution() = runTest {
        for (subagentRunId in listOf(null, "child1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    TextMessageStartEvent(messageId = "msg1", subagentRunId = "child1"),
                    TextMessageContentEvent(messageId = "msg1", delta = "Hello"),
                    TextMessageChunkEvent(delta = " world", subagentRunId = subagentRunId)
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testTextMetadataOnlyContinuationRejectsConflictingAttribution() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                TextMessageChunkEvent(messageId = "msg1", delta = "Hello", subagentRunId = "child1"),
                TextMessageChunkEvent(metadata = buildJsonObject { put("finishReason", "stop") }, subagentRunId = "child2")
            ).transformChunks().toList()
        }
    }
    
    @Test
    fun testToolCallChunkCreatesNewSequence() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallChunkEvent(
                toolCallId = "tool1",
                toolCallName = "test_tool", 
                delta = "{\"param\":"
            ),
            ToolCallChunkEvent(
                toolCallId = "tool1",
                delta = "\"value\"}"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(5, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is ToolCallStartEvent)
        assertEquals("tool1", (result[1] as ToolCallStartEvent).toolCallId)
        assertEquals("test_tool", (result[1] as ToolCallStartEvent).toolCallName)
        assertTrue(result[2] is ToolCallArgsEvent)
        assertEquals("{\"param\":", (result[2] as ToolCallArgsEvent).delta)
        assertTrue(result[3] is ToolCallArgsEvent)
        assertEquals("\"value\"}", (result[3] as ToolCallArgsEvent).delta)
        assertTrue(result[4] is ToolCallEndEvent)
        assertEquals("tool1", (result[4] as ToolCallEndEvent).toolCallId)
    }

    @Test
    fun testToolChunkClosesBeforeExplicitStartForDifferentCall() = runTest {
        val rawEvent = buildJsonObject { put("source", "explicit-start") }
        val metadata = buildJsonObject { put("source", "second-call") }
        for (subagentRunId in listOf(null, "child1")) {
            val explicitStart = ToolCallStartEvent(
                toolCallId = "tool2",
                toolCallName = "search",
                timestamp = 2L,
                rawEvent = rawEvent,
                metadata = metadata,
                subagentRunId = subagentRunId
            )
            val explicitArgs = ToolCallArgsEvent(toolCallId = "tool2", delta = "{}", subagentRunId = subagentRunId)
            val explicitEnd = ToolCallEndEvent(toolCallId = "tool2", subagentRunId = subagentRunId)
            val result = flowOf(
                ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{}", subagentRunId = subagentRunId),
                explicitStart,
                explicitArgs,
                explicitEnd
            ).transformChunks().toList()

            assertEquals(
                listOf(
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", subagentRunId = subagentRunId),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "{}", subagentRunId = subagentRunId),
                    ToolCallEndEvent(
                        toolCallId = "tool1",
                        timestamp = explicitStart.timestamp,
                        rawEvent = rawEvent,
                        subagentRunId = subagentRunId
                    ),
                    explicitStart,
                    explicitArgs,
                    explicitEnd
                ),
                result
            )
            val completeRun = listOf(RunStartedEvent(threadId = "t1", runId = "r1")) +
                result + RunFinishedEvent(threadId = "t1", runId = "r1")
            assertEquals(completeRun, completeRun.asFlow().verifyEvents().toList())
        }
    }

    @Test
    fun testToolChunkRejectsExplicitStartForSameCall() = runTest {
        for (subagentRunId in listOf(null, "child1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{}", subagentRunId = subagentRunId),
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", subagentRunId = subagentRunId)
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testToolChunkPreservesMetadataAndAttribution() = runTest {
        val metadata = buildJsonObject { put("source", "tool-chunk") }
        val rawEvent = buildJsonObject { put("sequence", 1) }
        val timestamp = 1234567890L
        val result = flowOf(
            ToolCallChunkEvent(
                toolCallId = "tool1",
                toolCallName = "lookup",
                parentMessageId = "msg1",
                delta = "{}",
                timestamp = timestamp,
                rawEvent = rawEvent,
                metadata = metadata,
                subagentRunId = "child1"
            )
        ).transformChunks().toList()

        assertEquals(
            listOf(
                ToolCallStartEvent(
                    toolCallId = "tool1",
                    toolCallName = "lookup",
                    parentMessageId = "msg1",
                    timestamp = timestamp,
                    rawEvent = rawEvent,
                    metadata = metadata,
                    subagentRunId = "child1"
                ),
                ToolCallArgsEvent(
                    toolCallId = "tool1",
                    delta = "{}",
                    timestamp = timestamp,
                    rawEvent = rawEvent,
                    metadata = metadata,
                    subagentRunId = "child1"
                ),
                ToolCallEndEvent(toolCallId = "tool1", subagentRunId = "child1")
            ),
            result
        )
    }

    @Test
    fun testToolChunkContinuationPreservesEachChunksMetadata() = runTest {
        val openerMetadata = buildJsonObject { put("source", "opener") }
        val firstMetadata = buildJsonObject { put("source", "first-continuation") }
        val secondMetadata = buildJsonObject { put("source", "second-continuation") }
        val firstRawEvent = buildJsonObject { put("sequence", 1) }
        val secondRawEvent = buildJsonObject { put("sequence", 2) }
        val result = flowOf(
            ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{", metadata = openerMetadata),
            ToolCallChunkEvent(
                delta = "\"value\":",
                timestamp = 1L,
                rawEvent = firstRawEvent,
                metadata = firstMetadata
            ),
            ToolCallChunkEvent(
                delta = "1",
                timestamp = 2L,
                rawEvent = secondRawEvent,
                metadata = secondMetadata
            ),
            ToolCallChunkEvent(delta = "}")
        ).transformChunks().toList()

        assertEquals(
            listOf(
                ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", metadata = openerMetadata),
                ToolCallArgsEvent(toolCallId = "tool1", delta = "{", metadata = openerMetadata),
                ToolCallArgsEvent(
                    toolCallId = "tool1",
                    delta = "\"value\":",
                    timestamp = 1L,
                    rawEvent = firstRawEvent,
                    metadata = firstMetadata
                ),
                ToolCallArgsEvent(
                    toolCallId = "tool1",
                    delta = "1",
                    timestamp = 2L,
                    rawEvent = secondRawEvent,
                    metadata = secondMetadata
                ),
                ToolCallArgsEvent(toolCallId = "tool1", delta = "}"),
                ToolCallEndEvent(toolCallId = "tool1")
            ),
            result
        )
    }

    @Test
    fun testToolMetadataOnlyContinuationEmitsEmptyArgs() = runTest {
        val rawEvent = buildJsonObject { put("source", "metadata-only-chunk") }
        val metadataValues = listOf(
            buildJsonObject { put("finishReason", "stop") },
            buildJsonObject {}
        )
        for (delta in listOf(null, "")) {
            for (metadata in metadataValues) {
                val result = flowOf(
                    ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{}", subagentRunId = "child1"),
                    ToolCallChunkEvent(delta = delta, timestamp = 2L, rawEvent = rawEvent, metadata = metadata)
                ).transformChunks().toList()

                assertEquals(
                    listOf(
                        ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", subagentRunId = "child1"),
                        ToolCallArgsEvent(toolCallId = "tool1", delta = "{}", subagentRunId = "child1"),
                        ToolCallArgsEvent(
                            toolCallId = "tool1",
                            delta = "",
                            timestamp = 2L,
                            rawEvent = rawEvent,
                            metadata = metadata,
                            subagentRunId = "child1"
                        ),
                        ToolCallEndEvent(toolCallId = "tool1", subagentRunId = "child1")
                    ),
                    result
                )
            }
        }
    }

    @Test
    fun testToolMetadataOnlyOpenerEmitsEmptyArgs() = runTest {
        val metadata = buildJsonObject { put("finishReason", "stop") }
        for (delta in listOf(null, "")) {
            val result = flowOf(
                ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = delta, metadata = metadata)
            ).transformChunks().toList()

            assertEquals(
                listOf(
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", metadata = metadata),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "", metadata = metadata),
                    ToolCallEndEvent(toolCallId = "tool1")
                ),
                result
            )
        }
    }

    @Test
    fun testToolChunksWithoutDeltaOrMetadataEmitNoArgs() = runTest {
        for (delta in listOf(null, "")) {
            val result = flowOf(
                ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = delta),
                ToolCallChunkEvent(delta = delta)
            ).transformChunks().toList()

            assertEquals(
                listOf(
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup"),
                    ToolCallEndEvent(toolCallId = "tool1")
                ),
                result
            )
        }
    }

    @Test
    fun testToolChunkContinuationAcceptsEqualAndOmittedIdentity() = runTest {
        for (parentMessageId in listOf(null, "msg1")) {
            val result = flowOf(
                ToolCallChunkEvent(
                    toolCallId = "tool1",
                    toolCallName = "lookup",
                    parentMessageId = parentMessageId,
                    delta = "{"
                ),
                ToolCallChunkEvent(
                    toolCallId = "tool1",
                    toolCallName = "lookup",
                    parentMessageId = parentMessageId,
                    delta = "\"value\":1"
                ),
                ToolCallChunkEvent(delta = "}")
            ).transformChunks().toList()

            assertEquals(
                listOf(
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", parentMessageId = parentMessageId),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "{"),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "\"value\":1"),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "}"),
                    ToolCallEndEvent(toolCallId = "tool1")
                ),
                result
            )
        }
    }

    @Test
    fun testChunkContinuationRejectsConflictingRepeatedParentMessageId() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                ToolCallChunkEvent(
                    toolCallId = "tool1",
                    toolCallName = "lookup",
                    parentMessageId = "msg1",
                    delta = "{",
                    subagentRunId = "sub-1"
                ),
                ToolCallChunkEvent(
                    toolCallId = "tool1",
                    toolCallName = "lookup",
                    parentMessageId = "msg2",
                    delta = "}",
                    subagentRunId = "sub-1"
                )
            ).transformChunks().toList()
        }
    }

    @Test
    fun testChunkContinuationRejectsConflictingRepeatedAttribution() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                ToolCallChunkEvent(
                    toolCallId = "tool1",
                    toolCallName = "lookup",
                    parentMessageId = "msg1",
                    delta = "{",
                    subagentRunId = "sub-1"
                ),
                ToolCallChunkEvent(
                    toolCallId = "tool1",
                    toolCallName = "lookup",
                    parentMessageId = "msg1",
                    delta = "}",
                    subagentRunId = "sub-2"
                )
            ).transformChunks().toList()
        }
    }

    @Test
    fun testToolChunkContinuationInheritsEqualAndOmittedAttribution() = runTest {
        for (subagentRunId in listOf(null, "child1")) {
            val result = flowOf(
                ToolCallChunkEvent(
                    toolCallId = "tool1",
                    toolCallName = "lookup",
                    delta = "{",
                    subagentRunId = subagentRunId
                ),
                ToolCallChunkEvent(delta = "\"value\":1"),
                ToolCallChunkEvent(toolCallId = "tool1", delta = "}", subagentRunId = subagentRunId)
            ).transformChunks().toList()

            assertEquals(
                listOf(
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", subagentRunId = subagentRunId),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "{", subagentRunId = subagentRunId),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "\"value\":1", subagentRunId = subagentRunId),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "}", subagentRunId = subagentRunId),
                    ToolCallEndEvent(toolCallId = "tool1", subagentRunId = subagentRunId)
                ),
                result
            )
        }
    }

    @Test
    fun testToolChunkContinuationRejectsConflictingAttributionWithoutId() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{", subagentRunId = "child1"),
                ToolCallChunkEvent(delta = "}", subagentRunId = "child2")
            ).transformChunks().toList()
        }
    }

    @Test
    fun testToolChunkContinuationRejectsAttributionAfterParentOpener() = runTest {
        for (toolCallId in listOf(null, "tool1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{"),
                    ToolCallChunkEvent(toolCallId = toolCallId, delta = "}", subagentRunId = "child1")
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testToolChunkEndKeepsOpenerAttributionWhenRunFinishes() = runTest {
        val closingRawEvent = buildJsonObject { put("source", "run-finished") }
        val closingEvent = RunFinishedEvent(
            threadId = "t1",
            runId = "r1",
            timestamp = 1234567891L,
            rawEvent = closingRawEvent,
            metadata = buildJsonObject { put("source", "run-finished") }
        )
        for (subagentRunId in listOf(null, "child1")) {
            val result = flowOf(
                ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{}", subagentRunId = subagentRunId),
                closingEvent
            ).transformChunks().toList()

            assertEquals(
                listOf(
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", subagentRunId = subagentRunId),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "{}", subagentRunId = subagentRunId),
                    ToolCallEndEvent(
                        toolCallId = "tool1",
                        timestamp = closingEvent.timestamp,
                        rawEvent = closingRawEvent,
                        metadata = null,
                        subagentRunId = subagentRunId
                    ),
                    closingEvent
                ),
                result
            )
        }
    }

    @Test
    fun testToolChunkRejectsExplicitOpenerEvenWithMatchingAttribution() = runTest {
        for (subagentRunId in listOf(null, "child1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", subagentRunId = "child1"),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "{"),
                    ToolCallChunkEvent(delta = "}", subagentRunId = subagentRunId)
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testToolMetadataOnlyContinuationRejectsConflictingAttribution() = runTest {
        for (subagentRunId in listOf(null, "child1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{}", subagentRunId = subagentRunId),
                    ToolCallChunkEvent(metadata = buildJsonObject { put("finishReason", "stop") }, subagentRunId = "child2")
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testToolChunkRejectsExplicitArgsWithoutAnOpener() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                ToolCallArgsEvent(toolCallId = "tool1", delta = "{", subagentRunId = "child1"),
                ToolCallChunkEvent(delta = "}", subagentRunId = "child1")
            ).transformChunks().toList()
        }
    }

    @Test
    fun testToolCallIdChangeAllowsDifferentAttribution() = runTest {
        val result = flowOf(
            ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{}", subagentRunId = "child1"),
            ToolCallChunkEvent(toolCallId = "tool2", toolCallName = "search", delta = "{}", subagentRunId = "child2")
        ).transformChunks().toList()

        assertEquals(
            listOf(
                ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", subagentRunId = "child1"),
                ToolCallArgsEvent(toolCallId = "tool1", delta = "{}", subagentRunId = "child1"),
                ToolCallStartEvent(toolCallId = "tool2", toolCallName = "search", subagentRunId = "child2"),
                ToolCallArgsEvent(toolCallId = "tool2", delta = "{}", subagentRunId = "child2"),
                ToolCallEndEvent(toolCallId = "tool1", subagentRunId = "child1"),
                ToolCallEndEvent(toolCallId = "tool2", subagentRunId = "child2")
            ),
            result
        )
    }

    @Test
    fun testToolChunkContinuationRejectsConflictingRepeatedName() = runTest {
        for (toolCallId in listOf(null, "tool1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{"),
                    ToolCallChunkEvent(toolCallId = toolCallId, toolCallName = "search", delta = "}")
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testToolChunkContinuationRejectsParentAfterUnparentedOpener() = runTest {
        for (toolCallId in listOf(null, "tool1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{"),
                    ToolCallChunkEvent(toolCallId = toolCallId, parentMessageId = "msg1", delta = "}")
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testToolChunkRejectsExplicitOpenerEvenWithMatchingIdentity() = runTest {
        for (toolCallId in listOf(null, "tool1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", parentMessageId = "msg1"),
                    ToolCallChunkEvent(toolCallId = toolCallId, toolCallName = "lookup", parentMessageId = "msg1", delta = "{}")
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testToolMetadataOnlyContinuationRejectsConflictingParent() = runTest {
        for (parentMessageId in listOf(null, "msg1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", parentMessageId = parentMessageId, delta = "{}"),
                    ToolCallChunkEvent(parentMessageId = "msg2", metadata = buildJsonObject { put("finishReason", "stop") })
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testToolCallIdChangeAllowsDifferentParentMessageId() = runTest {
        val result = flowOf(
            ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", parentMessageId = "msg1", delta = "{}"),
            ToolCallChunkEvent(toolCallId = "tool2", toolCallName = "search", parentMessageId = "msg2", delta = "{}")
        ).transformChunks().toList()

        assertEquals(
            listOf(
                ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", parentMessageId = "msg1"),
                ToolCallArgsEvent(toolCallId = "tool1", delta = "{}"),
                ToolCallEndEvent(toolCallId = "tool1"),
                ToolCallStartEvent(toolCallId = "tool2", toolCallName = "search", parentMessageId = "msg2"),
                ToolCallArgsEvent(toolCallId = "tool2", delta = "{}"),
                ToolCallEndEvent(toolCallId = "tool2")
            ),
            result
        )
    }

    @Test
    fun testTextChunkRejectsContinuationAfterExplicitContent() = runTest {
        for (messageId in listOf(null, "msg1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    RunStartedEvent(threadId = "t1", runId = "r1"),
                    TextMessageStartEvent(messageId = "msg1"),
                    TextMessageContentEvent(messageId = "msg1", delta = "Hello"),
                    TextMessageChunkEvent(messageId = messageId, delta = " from chunk")
                ).transformChunks().toList()
            }
        }
    }

    @Test
    fun testToolChunkRejectsContinuationAfterExplicitArgs() = runTest {
        for (toolCallId in listOf(null, "tool1")) {
            assertFailsWith<IllegalArgumentException> {
                flowOf(
                    RunStartedEvent(threadId = "t1", runId = "r1"),
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "test_tool"),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "{"),
                    ToolCallChunkEvent(toolCallId = toolCallId, delta = "}")
                ).transformChunks().toList()
            }
        }
    }
    
    @Test
    fun testTextChunkClosesToolCall() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallStartEvent(toolCallId = "tool1", toolCallName = "test_tool"),
            TextMessageChunkEvent(
                messageId = "msg1", 
                delta = "Hello"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(5, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is ToolCallStartEvent)
        assertTrue(result[2] is TextMessageStartEvent)
        assertEquals("msg1", (result[2] as TextMessageStartEvent).messageId)
        assertTrue(result[3] is TextMessageContentEvent)
        assertEquals("Hello", (result[3] as TextMessageContentEvent).delta)
        assertTrue(result[4] is TextMessageEndEvent)
        assertEquals("msg1", (result[4] as TextMessageEndEvent).messageId)
    }
    
    @Test
    fun testToolChunkClosesTextMessage() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "msg1"),
            ToolCallChunkEvent(
                toolCallId = "tool1",
                toolCallName = "test_tool",
                delta = "{}"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(5, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is TextMessageStartEvent)
        assertEquals("msg1", (result[1] as TextMessageStartEvent).messageId)
        assertTrue(result[2] is ToolCallStartEvent)
        assertEquals("tool1", (result[2] as ToolCallStartEvent).toolCallId)
        assertTrue(result[3] is ToolCallArgsEvent)
        assertEquals("{}", (result[3] as ToolCallArgsEvent).delta)
        assertTrue(result[4] is ToolCallEndEvent)
        assertEquals("tool1", (result[4] as ToolCallEndEvent).toolCallId)
    }
    
    @Test
    fun testMessageIdChangeCreatesNewMessage() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageChunkEvent(messageId = "msg1", delta = "First"),
            TextMessageChunkEvent(messageId = "msg2", delta = "Second")
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(7, result.size)
        assertTrue(result[0] is RunStartedEvent)
        // First message
        assertTrue(result[1] is TextMessageStartEvent)
        assertEquals("msg1", (result[1] as TextMessageStartEvent).messageId)
        assertTrue(result[2] is TextMessageContentEvent)
        assertEquals("First", (result[2] as TextMessageContentEvent).delta)
        assertTrue(result[3] is TextMessageEndEvent)
        assertNull(result[3].timestamp)
        assertEquals("msg1", (result[3] as TextMessageEndEvent).messageId)
        // Second message
        assertTrue(result[4] is TextMessageStartEvent)
        assertEquals("msg2", (result[4] as TextMessageStartEvent).messageId)
        assertTrue(result[5] is TextMessageContentEvent)
        assertEquals("Second", (result[5] as TextMessageContentEvent).delta)
        assertTrue(result[6] is TextMessageEndEvent)
        assertEquals("msg2", (result[6] as TextMessageEndEvent).messageId)
    }
    
    @Test
    fun testToolCallIdChangeCreatesNewToolCall() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallChunkEvent(
                toolCallId = "tool1",
                toolCallName = "first_tool", 
                delta = "first"
            ),
            ToolCallChunkEvent(
                toolCallId = "tool2",
                toolCallName = "second_tool",
                delta = "second"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(7, result.size)
        assertTrue(result[0] is RunStartedEvent)
        // First tool call
        assertTrue(result[1] is ToolCallStartEvent)
        assertEquals("tool1", (result[1] as ToolCallStartEvent).toolCallId)
        assertEquals("first_tool", (result[1] as ToolCallStartEvent).toolCallName)
        assertTrue(result[2] is ToolCallArgsEvent)
        assertEquals("first", (result[2] as ToolCallArgsEvent).delta)
        assertTrue(result[3] is ToolCallEndEvent)
        assertEquals("tool1", (result[3] as ToolCallEndEvent).toolCallId)
        // Second tool call
        assertTrue(result[4] is ToolCallStartEvent)
        assertEquals("tool2", (result[4] as ToolCallStartEvent).toolCallId)
        assertEquals("second_tool", (result[4] as ToolCallStartEvent).toolCallName)
        assertTrue(result[5] is ToolCallArgsEvent)
        assertEquals("second", (result[5] as ToolCallArgsEvent).delta)
        assertTrue(result[6] is ToolCallEndEvent)
        assertEquals("tool2", (result[6] as ToolCallEndEvent).toolCallId)
    }
    
    @Test
    fun testTextChunkWithoutMessageIdThrowsWhenStartingNew() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageChunkEvent(delta = "Hello")
        )
        
        assertFailsWith<IllegalArgumentException> {
            events.transformChunks().collect {}
        }
    }
    
    @Test
    fun testToolChunkWithoutRequiredFieldsThrowsWhenStartingNew() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallChunkEvent(delta = "args")
        )
        
        assertFailsWith<IllegalArgumentException> {
            events.transformChunks().collect {}
        }
    }
    
    @Test
    fun testChunkWithoutDeltaGeneratesNoContentEvent() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageChunkEvent(messageId = "msg1"),
            ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "test_tool")
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(5, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is TextMessageStartEvent)
        assertTrue(result[2] is TextMessageEndEvent)
        assertEquals("msg1", (result[2] as TextMessageEndEvent).messageId)
        assertTrue(result[3] is ToolCallStartEvent)
        assertTrue(result[4] is ToolCallEndEvent)
        assertEquals("tool1", (result[4] as ToolCallEndEvent).toolCallId)
    }
    
    @Test
    fun testTransformPreservesTimestampsAndRawEvents() = runTest {
        val timestamp = 1234567890L
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageChunkEvent(
                messageId = "msg1", 
                delta = "Hello",
                timestamp = timestamp
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(4, result.size)
        assertTrue(result[1] is TextMessageStartEvent)
        assertEquals(timestamp, result[1].timestamp)
        assertTrue(result[2] is TextMessageContentEvent)
        assertEquals(timestamp, result[2].timestamp)
        assertTrue(result[3] is TextMessageEndEvent)
    }

    @Test
    fun testTextChunkRejectsExplicitContentWithoutAnOpener() = runTest {
        assertFailsWith<IllegalArgumentException> {
            flowOf(
                TextMessageContentEvent(messageId = "msg1", delta = "Hello", subagentRunId = "child1"),
                TextMessageChunkEvent(delta = " world", subagentRunId = "child1")
            ).transformChunks().toList()
        }
    }

    @Test
    fun testTextChunkClosesBeforeExplicitContentForSameMessage() = runTest {
        for (subagentRunId in listOf(null, "child1")) {
            val runStart = RunStartedEvent(threadId = "t1", runId = "r1")
            val runEnd = RunFinishedEvent(threadId = "t1", runId = "r1")
            val explicitContent = TextMessageContentEvent(messageId = "msg1", delta = " world", subagentRunId = subagentRunId)
            val explicitEnd = TextMessageEndEvent(messageId = "msg1", subagentRunId = subagentRunId)
            val result = flowOf(
                runStart,
                TextMessageChunkEvent(messageId = "msg1", delta = "Hello", subagentRunId = subagentRunId),
                explicitContent,
                explicitEnd,
                runEnd
            ).transformChunks().toList()

            val error = assertFailsWith<AGUIError> { result.asFlow().verifyEvents().toList() }
            assertContains(error.message.orEmpty(), "No active text message found")
            assertEquals(
                listOf(
                    runStart,
                    TextMessageStartEvent(messageId = "msg1", subagentRunId = subagentRunId),
                    TextMessageContentEvent(messageId = "msg1", delta = "Hello", subagentRunId = subagentRunId),
                    TextMessageEndEvent(messageId = "msg1", subagentRunId = subagentRunId),
                    explicitContent,
                    explicitEnd,
                    runEnd
                ),
                result
            )
        }
    }

    @Test
    fun testTextChunkClosesBeforeExplicitEndForSameMessage() = runTest {
        for (subagentRunId in listOf(null, "child1")) {
            val runStart = RunStartedEvent(threadId = "t1", runId = "r1")
            val runEnd = RunFinishedEvent(threadId = "t1", runId = "r1")
            val rawEvent = buildJsonObject { put("source", "explicit-end") }
            val explicitEnd = TextMessageEndEvent(
                messageId = "msg1", timestamp = 2L, rawEvent = rawEvent, subagentRunId = subagentRunId
            )
            val result = flowOf(
                runStart,
                TextMessageChunkEvent(messageId = "msg1", delta = "Hello", subagentRunId = subagentRunId),
                explicitEnd,
                runEnd
            ).transformChunks().toList()

            val error = assertFailsWith<AGUIError> { result.asFlow().verifyEvents().toList() }
            assertContains(error.message.orEmpty(), "No active text message found")
            assertEquals(
                listOf(
                    runStart,
                    TextMessageStartEvent(messageId = "msg1", subagentRunId = subagentRunId),
                    TextMessageContentEvent(messageId = "msg1", delta = "Hello", subagentRunId = subagentRunId),
                    explicitEnd,
                    explicitEnd,
                    runEnd
                ),
                result
            )
        }
    }

    @Test
    fun testToolChunkClosesBeforeExplicitArgsForSameCall() = runTest {
        for (subagentRunId in listOf(null, "child1")) {
            val runStart = RunStartedEvent(threadId = "t1", runId = "r1")
            val runEnd = RunFinishedEvent(threadId = "t1", runId = "r1")
            val explicitArgs = ToolCallArgsEvent(toolCallId = "tool1", delta = "}", subagentRunId = subagentRunId)
            val explicitEnd = ToolCallEndEvent(toolCallId = "tool1", subagentRunId = subagentRunId)
            val result = flowOf(
                runStart,
                ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{", subagentRunId = subagentRunId),
                explicitArgs,
                explicitEnd,
                runEnd
            ).transformChunks().toList()

            val error = assertFailsWith<AGUIError> { result.asFlow().verifyEvents().toList() }
            assertContains(error.message.orEmpty(), "No active tool call found")
            assertEquals(
                listOf(
                    runStart,
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", subagentRunId = subagentRunId),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "{", subagentRunId = subagentRunId),
                    ToolCallEndEvent(toolCallId = "tool1", subagentRunId = subagentRunId),
                    explicitArgs,
                    explicitEnd,
                    runEnd
                ),
                result
            )
        }
    }

    @Test
    fun testToolChunkClosesBeforeExplicitEndForSameCall() = runTest {
        for (subagentRunId in listOf(null, "child1")) {
            val runStart = RunStartedEvent(threadId = "t1", runId = "r1")
            val runEnd = RunFinishedEvent(threadId = "t1", runId = "r1")
            val rawEvent = buildJsonObject { put("source", "explicit-end") }
            val explicitEnd = ToolCallEndEvent(
                toolCallId = "tool1", timestamp = 2L, rawEvent = rawEvent, subagentRunId = subagentRunId
            )
            val result = flowOf(
                runStart,
                ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "lookup", delta = "{}", subagentRunId = subagentRunId),
                explicitEnd,
                runEnd
            ).transformChunks().toList()

            val error = assertFailsWith<AGUIError> { result.asFlow().verifyEvents().toList() }
            assertContains(error.message.orEmpty(), "No active tool call found")
            assertEquals(
                listOf(
                    runStart,
                    ToolCallStartEvent(toolCallId = "tool1", toolCallName = "lookup", subagentRunId = subagentRunId),
                    ToolCallArgsEvent(toolCallId = "tool1", delta = "{}", subagentRunId = subagentRunId),
                    explicitEnd,
                    explicitEnd,
                    runEnd
                ),
                result
            )
        }
    }
}
