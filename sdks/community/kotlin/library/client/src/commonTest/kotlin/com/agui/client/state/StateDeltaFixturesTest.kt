package com.agui.client.state

import com.agui.core.types.*
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.*

class StateDeltaFixturesTest {

    @Test
    fun sharedApplierMatchesFixtures() {
        for (fixture in stateDeltaFixtures) {
            val document = json(fixture.document)
            val delta = patch(fixture.delta)
            when (val outcome = fixture.outcome) {
                is StateDeltaOutcome.Applied ->
                    assertEquals(json(outcome.document), applyStateDelta(delta, document), fixture.name)
                else -> {
                    val error = assertFailsWith<JsonPatchApplicationException>(fixture.name) {
                        applyStateDelta(delta, document)
                    }
                    assertReason(fixture, error)
                }
            }
        }
    }

    @Test
    fun stateManagerMatchesFixtures() = runTest {
        for (fixture in stateDeltaFixtures) {
            val initialState = json(fixture.document)
            val delta = patch(fixture.delta)
            val errors = mutableListOf<Pair<Throwable, JsonArray?>>()
            val deltas = mutableListOf<JsonArray>()
            val stateManager = StateManager(
                handler = stateHandler(
                    onDelta = { deltas += it },
                    onError = { error, failed -> errors += error to failed }
                ),
                initialState = initialState
            )

            stateManager.processEvent(StateDeltaEvent(delta))

            when (val outcome = fixture.outcome) {
                is StateDeltaOutcome.Applied -> {
                    assertEquals(json(outcome.document), stateManager.currentState.value, fixture.name)
                    assertEquals(listOf(delta), deltas, fixture.name)
                    assertTrue(errors.isEmpty(), fixture.name)
                }
                else -> {
                    // Atomic: no operation of a rejected delta is applied.
                    assertEquals(initialState, stateManager.currentState.value, fixture.name)
                    assertTrue(deltas.isEmpty(), fixture.name)
                    val (error, failed) = errors.single()
                    assertIs<JsonPatchApplicationException>(error, fixture.name)
                    assertReason(fixture, error)
                    assertEquals(delta, failed, fixture.name)

                    stateManager.processEvent(StateDeltaEvent(recovery))

                    assertEquals(recovered, stateManager.currentState.value, fixture.name)
                    assertEquals(listOf(recovery), deltas, fixture.name)
                    assertEquals(1, errors.size, fixture.name)
                }
            }
        }
    }

    @Test
    fun eventPipelineMatchesFixtures() = runTest {
        // The pipeline drops unknown operations before applying; see unknownOperationPolicy.
        for (fixture in stateDeltaFixtures.filter { it.name != "unknown op" }) {
            val initialState = json(fixture.document)
            val delta = patch(fixture.delta)
            val errors = mutableListOf<Pair<Throwable, JsonArray?>>()
            val deltas = mutableListOf<JsonArray>()
            val handler = stateHandler(
                onDelta = { deltas += it },
                onError = { error, failed -> errors += error to failed }
            )
            val events = flowOf<BaseEvent>(StateDeltaEvent(delta = delta), StateDeltaEvent(delta = recovery))
            val input = RunAgentInput(threadId = "thread", runId = "run", state = initialState)

            when (val outcome = fixture.outcome) {
                is StateDeltaOutcome.Applied -> {
                    val states = defaultApplyEvents(input, events, stateHandler = handler).toList()
                    assertEquals(listOf(json(outcome.document), recovered), states.mapNotNull { it.state }, fixture.name)
                    assertEquals(listOf(delta, recovery), deltas, fixture.name)
                    assertTrue(errors.isEmpty(), fixture.name)
                }
                StateDeltaOutcome.Malformed -> {
                    // The pipeline validates events at its boundary; a malformed delta fails the run.
                    assertFails(fixture.name) {
                        defaultApplyEvents(input, events, stateHandler = handler).toList()
                    }
                    assertTrue(deltas.isEmpty(), fixture.name)
                    assertTrue(errors.isEmpty(), fixture.name)
                }
                else -> {
                    val states = defaultApplyEvents(input, events, stateHandler = handler).toList()
                    // The rejected delta emits no state; the next valid delta still applies.
                    assertEquals(listOf(recovered), states.mapNotNull { it.state }, fixture.name)
                    assertEquals(listOf(recovery), deltas, fixture.name)
                    val (error, failed) = errors.single()
                    assertIs<JsonPatchApplicationException>(error, fixture.name)
                    assertReason(fixture, error)
                    assertEquals(delta, failed, fixture.name)
                }
            }
        }
    }

    @Test
    fun unknownOperationPolicy() = runTest {
        // The event pipeline drops unknown operations and applies the rest; StateManager rejects the
        // whole delta. Aligning the two would be a separate behaviour change.
        val initialState = json("""{"count":0}""")
        val delta = patch("""[{"op":"futureOperation","path":"/count"},{"op":"replace","path":"/count","value":1}]""")

        val pipelineStates = defaultApplyEvents(
            RunAgentInput(threadId = "thread", runId = "run", state = initialState),
            flowOf<BaseEvent>(StateDeltaEvent(delta = delta))
        ).toList()
        assertEquals(listOf(json("""{"count":1}""")), pipelineStates.mapNotNull { it.state })

        var error: Throwable? = null
        val stateManager = StateManager(
            handler = stateHandler(onError = { e, _ -> error = e }),
            initialState = initialState
        )
        stateManager.processEvent(StateDeltaEvent(delta))
        assertEquals(initialState, stateManager.currentState.value)
        assertIs<JsonPatchApplicationException>(error)
    }

    private fun assertReason(fixture: StateDeltaFixture, error: Throwable) {
        val message = error.message.orEmpty()
        when (fixture.outcome) {
            StateDeltaOutcome.Malformed ->
                assertTrue(message.startsWith("Invalid state delta"), "${fixture.name}: $message")
            StateDeltaOutcome.AbsentDocument ->
                assertTrue(message.contains("absent document"), "${fixture.name}: $message")
            StateDeltaOutcome.Unapplicable -> {
                assertFalse(message.startsWith("Invalid state delta"), "${fixture.name}: $message")
                assertFalse(message.contains("absent document"), "${fixture.name}: $message")
            }
            is StateDeltaOutcome.Applied -> fail("${fixture.name} should apply")
        }
    }

    private val recovery = patch("""[{"op":"replace","path":"","value":{"recovered":true}}]""")
    private val recovered = json("""{"recovered":true}""")

    private fun json(value: String): JsonElement = Json.parseToJsonElement(value)

    private fun patch(value: String): JsonArray = json(value).jsonArray
}
