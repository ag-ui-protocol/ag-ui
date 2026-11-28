package com.agui.client.state

import com.agui.core.types.StateSnapshotEvent
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class ConcurrentStatePublicationTest {
    @Test
    fun concurrentEqualSnapshotsDoNotEmitDuplicates() = runBlocking {
        fun state(n: Int) = JsonObject(mapOf("a" to JsonPrimitive(n)))
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        // Immutable content; delay get() only to control the comparison interleaving.
        val gated = object : AbstractMap<String, JsonElement>() {
            override val entries: Set<Map.Entry<String, JsonElement>>
                get() = mapOf("a" to JsonPrimitive(1)).entries
            override fun get(key: String): JsonElement? {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
                return if (key == "a") JsonPrimitive(1) else null
            }
        }
        val manager = StateManager(initialState = state(0))
        val emitted = mutableListOf<JsonElement>()
        val collector = launch(Dispatchers.Unconfined) {
            manager.currentState.collect { synchronized(emitted) { emitted += it } }
        }
        val failure = AtomicReference<Throwable?>()
        fun publisher(value: JsonElement) = Thread {
            try { runBlocking { manager.processEvent(StateSnapshotEvent(value)) } }
            catch (t: Throwable) { failure.set(t) }
        }
        val delayed = publisher(JsonObject(gated))
        val normal = publisher(state(1))
        delayed.start()
        try {
            check(entered.await(5, TimeUnit.SECONDS))
            normal.start()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            // Base: second setter waits on StateFlow's monitor. PR: it completes.
            while (normal.isAlive && !(normal.state == Thread.State.BLOCKED &&
                normal.stackTrace.any { it.className.contains("StateFlowImpl") })) {
                check(System.nanoTime() < deadline)
                Thread.sleep(1)
            }
        } finally { release.countDown() }
        delayed.join(5000)
        normal.join(5000)
        collector.cancelAndJoin()
        assertFalse(delayed.isAlive || normal.isAlive)
        failure.get()?.let { throw it }
        assertEquals(2, synchronized(emitted) { emitted.size })
    }
}
