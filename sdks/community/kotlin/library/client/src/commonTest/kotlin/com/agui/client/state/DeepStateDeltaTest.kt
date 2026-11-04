package com.agui.client.state

import com.agui.client.agent.AbstractAgent
import com.agui.client.sse.SseParser
import com.agui.core.types.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.asFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Patches applied to state nested far deeper than a call stack can recurse. Nothing here compares
 * or prints a whole document, because JsonElement's equals and toString recurse.
 */
class DeepStateDeltaTest {
    private val depth = 100_000
    private val leafPath = "/a".repeat(depth)

    private fun nested(levels: Int = depth, leaf: JsonElement = JsonPrimitive(0)): JsonElement {
        var document = leaf
        repeat(levels) { document = JsonObject(mapOf("a" to document)) }
        return document
    }

    private fun levels(document: JsonElement): Int {
        var count = 0
        var current = document
        while (current is JsonObject) {
            current = current["a"] ?: break
            count++
        }
        return count
    }

    private fun leaf(document: JsonElement, levels: Int = depth): JsonElement? {
        var current: JsonElement? = document
        repeat(levels) { current = (current as? JsonObject)?.get("a") }
        return current
    }

    private fun patch(op: String, path: String, value: JsonElement? = null, from: String? = null): JsonArray =
        buildJsonArray {
            add(buildJsonObject {
                put("op", op)
                put("path", path)
                value?.let { put("value", it) }
                from?.let { put("from", it) }
            })
        }

    private fun input(state: JsonElement): RunAgentInput =
        RunAgentInput(threadId = "thread", runId = "run", state = state)

    @Test
    fun replaceReachesTheBottomOfDeepState() {
        val patched = applyStateDelta(patch("replace", leafPath, JsonPrimitive(1)), nested())

        assertEquals(JsonPrimitive(1), leaf(patched))
    }

    @Test
    fun addReachesTheBottomOfDeepState() {
        val patched = applyStateDelta(patch("add", leafPath, JsonPrimitive(1)), nested())

        assertEquals(JsonPrimitive(1), leaf(patched))
    }

    @Test
    fun removeReachesTheBottomOfDeepState() {
        val patched = applyStateDelta(patch("remove", leafPath), nested())

        assertEquals(depth - 1, levels(patched))
    }

    @Test
    fun copyReachesTheBottomOfDeepState() {
        val document = JsonObject(mapOf("a" to nested(depth - 1), "source" to JsonPrimitive(1)))

        val patched = applyStateDelta(patch("copy", leafPath, from = "/source"), document)

        assertEquals(JsonPrimitive(1), leaf(patched))
    }

    @Test
    fun moveLeavesTheBottomOfDeepState() {
        val patched = applyStateDelta(patch("move", "/moved", from = leafPath), nested())

        assertEquals(depth - 1, levels(patched))
        assertEquals(JsonPrimitive(0), (patched as JsonObject)["moved"])
    }

    @Test
    fun testOperationComparesDeepValues() {
        val document = nested(leaf = JsonPrimitive(1))

        // 1.0 equals 1 by value, so the operands differ and == cannot settle the comparison early.
        val patched = applyStateDelta(patch("test", "", nested(leaf = JsonPrimitive(1.0))), document)

        assertEquals(depth, levels(patched))
    }

    @Test
    fun testOperationRejectsDeepValuesThatDiffer() {
        val mismatch = patch("test", "", nested(leaf = JsonPrimitive(2)))

        assertFailsWith<JsonPatchApplicationException> {
            applyStateDelta(mismatch, nested(leaf = JsonPrimitive(1)))
        }
    }

    @Test
    fun eventPipelineAppliesDeltaToDeepState() = runTest {
        val states = defaultApplyEvents(
            input(nested()),
            flowOf<BaseEvent>(StateDeltaEvent(delta = patch("replace", leafPath, JsonPrimitive(1))))
        ).toList()

        assertEquals(JsonPrimitive(1), leaf(assertNotNull(states.mapNotNull { it.state }.last())))
    }

    @Test
    fun eventPipelineReportsDeltaThatFailsOnDeepState() = runTest {
        var reported: Throwable? = null

        val states = defaultApplyEvents(
            input(nested()),
            flowOf<BaseEvent>(StateDeltaEvent(delta = patch("replace", "$leafPath/missing", JsonPrimitive(1)))),
            stateHandler = stateHandler(onError = { error, _ -> reported = error })
        ).toList()

        assertIs<JsonPatchApplicationException>(reported)
        assertTrue(states.none { it.state != null })
    }

    @Test
    fun agentRunAppliesDeltaToDeepState() = runTest {
        val agent = object : AbstractAgent() {
            override fun run(input: RunAgentInput): Flow<BaseEvent> = flowOf(
                RunStartedEvent(threadId = input.threadId, runId = input.runId),
                StateDeltaEvent(delta = patch("replace", leafPath, JsonPrimitive(1))),
                RunFinishedEvent(threadId = input.threadId, runId = input.runId)
            )

            fun resultState(): JsonElement = state

            fun seed(document: JsonElement) {
                state = document
            }
        }
        agent.seed(nested())

        agent.runAgent()

        assertEquals(JsonPrimitive(1), leaf(agent.resultState()))
    }

    @Test
    fun deltasFromTheSseParserCanNestStatePastItsDepthLimit() = runTest {
        val rounds = 200
        val perDelta = 100
        assertTrue(perDelta < SseParser.MAX_JSON_DEPTH)
        val value = "{\"a\":".repeat(perDelta) + "0" + "}".repeat(perDelta)
        val payloads = (0 until rounds).map { round ->
            val path = "/a".repeat(round * perDelta) + "/a"
            """{"type":"STATE_DELTA","delta":[{"op":"add","path":"$path","value":$value}]}"""
        }

        val events = SseParser(strictV1 = true).parseFlow(payloads.asFlow())
        var finalState: JsonElement? = null
        defaultApplyEvents(input(JsonObject(emptyMap())), events).collect { update ->
            update.state?.let { finalState = it }
        }

        assertEquals(rounds * perDelta + 1, levels(assertNotNull(finalState)))
    }

    @Test
    fun malformedPointerStaysFatalWhenItIsLong() = runTest {
        var reportedError = false

        assertFailsWith<IllegalArgumentException> {
            defaultApplyEvents(
                input(nested()),
                flowOf<BaseEvent>(StateDeltaEvent(delta = patch("replace", "$leafPath~2", JsonPrimitive(1)))),
                stateHandler = stateHandler(onError = { _, _ -> reportedError = true })
            ).toList()
        }

        assertEquals(false, reportedError)
    }
}
