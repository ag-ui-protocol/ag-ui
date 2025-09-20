package com.agui.tests

import com.agui.core.types.AgUiJson
import com.agui.core.types.*
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.*
import kotlin.test.*

@OptIn(ExperimentalSerializationApi::class)
class RunAgentInputProtocolTest {

    private val json = AgUiJson

    @Test
    fun testMinimalRunAgentInput() {
        val input = RunAgentInput(
            threadId = "thread_abc123",
            runId = "run_xyz789"
        )

        val jsonString = json.encodeToString(input)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // Required fields
        assertEquals("thread_abc123", jsonObj["threadId"]?.jsonPrimitive?.content)
        assertEquals("run_xyz789", jsonObj["runId"]?.jsonPrimitive?.content)

        // Fields with default values should be present
        assertTrue(jsonObj.containsKey("state"))
        assertTrue(jsonObj["state"]?.jsonObject?.isEmpty() == true)
        assertTrue(jsonObj["messages"]?.jsonArray?.isEmpty() == true)
        assertTrue(jsonObj["tools"]?.jsonArray?.isEmpty() == true)
        assertTrue(jsonObj["context"]?.jsonArray?.isEmpty() == true)
        assertTrue(jsonObj.containsKey("forwardedProps"))
        assertTrue(jsonObj["forwardedProps"]?.jsonObject?.isEmpty() == true)

        val decoded = json.decodeFromString<RunAgentInput>(jsonString)
        assertEquals(input, decoded)
    }

    @Test
    fun testFullRunAgentInput() {
        val state = buildJsonObject {
            put("user_id", "user_123")
            put("session", buildJsonObject {
                put("started_at", "2024-01-15T10:00:00Z")
                put("locale", "en-US")
            })
        }

        val messages = listOf(
            SystemMessage(
                id = "sys_1",
                content = "You are a helpful assistant."
            ),
            UserMessage(
                id = "user_1",
                content = "What's the weather like?"
            ),
            AssistantMessage(
                id = "asst_1",
                content = "I'll check the weather for you.",
                toolCalls = listOf(
                    ToolCall(
                        id = "call_weather",
                        function = FunctionCall(
                            name = "get_weather",
                            arguments = """{"location": "current"}"""
                        )
                    )
                )
            ),
            ToolMessage(
                id = "tool_1",
                content = """{"temperature": 72, "condition": "sunny"}""",
                toolCallId = "call_weather"
            ),
            AssistantMessage(
                id = "asst_2",
                content = "It's currently 72°F and sunny."
            )
        )

        val tools = listOf(
            Tool(
                name = "get_weather",
                description = "Get current weather for a location",
                parameters = buildJsonObject {
                    put("type", "object")
                    put("properties", buildJsonObject {
                        put("location", buildJsonObject {
                            put("type", "string")
                            put("description", "Location to get weather for")
                        })
                    })
                    put("required", JsonArray(listOf(JsonPrimitive("location"))))
                }
            ),
            Tool(
                name = "calculate",
                description = "Perform mathematical calculations",
                parameters = buildJsonObject {
                    put("type", "object")
                    put("properties", buildJsonObject {
                        put("expression", buildJsonObject {
                            put("type", "string")
                        })
                    })
                }
            )
        )

        val context = listOf(
            Context(
                description = "User timezone",
                value = "America/New_York"
            ),
            Context(
                description = "User preferences",
                value = "metric units preferred"
            )
        )

        val forwardedProps = buildJsonObject {
            put("custom_flag", true)
            put("request_id", "req_12345")
        }

        val input = RunAgentInput(
            threadId = "thread_full",
            runId = "run_full",
            state = state,
            messages = messages,
            tools = tools,
            context = context,
            forwardedProps = forwardedProps
        )

        val jsonString = json.encodeToString(input)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // Verify all fields are present
        assertEquals("thread_full", jsonObj["threadId"]?.jsonPrimitive?.content)
        assertEquals("run_full", jsonObj["runId"]?.jsonPrimitive?.content)
        assertNotNull(jsonObj["state"])
        assertEquals(5, jsonObj["messages"]?.jsonArray?.size)
        assertEquals(2, jsonObj["tools"]?.jsonArray?.size)
        assertEquals(2, jsonObj["context"]?.jsonArray?.size)
        assertNotNull(jsonObj["forwardedProps"])

        val decoded = json.decodeFromString<RunAgentInput>(jsonString)
        assertEquals(input.threadId, decoded.threadId)
        assertEquals(input.runId, decoded.runId)
        assertEquals(input.messages.size, decoded.messages.size)
        assertEquals(input.tools.size, decoded.tools.size)
        assertEquals(input.context.size, decoded.context.size)
    }

    @Test
    fun testToolSerialization() {
        val tool = Tool(
            name = "search_web",
            description = "Search the web for information",
            parameters = buildJsonObject {
                put("type", "object")
                put("properties", buildJsonObject {
                    put("query", buildJsonObject {
                        put("type", "string")
                        put("description", "Search query")
                    })
                    put("num_results", buildJsonObject {
                        put("type", "integer")
                        put("description", "Number of results to return")
                        put("default", 10)
                        put("minimum", 1)
                        put("maximum", 100)
                    })
                    put("safe_search", buildJsonObject {
                        put("type", "boolean")
                        put("default", true)
                    })
                })
                put("required", JsonArray(listOf(JsonPrimitive("query"))))
                put("additionalProperties", false)
            }
        )

        val jsonString = json.encodeToString(tool)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("search_web", jsonObj["name"]?.jsonPrimitive?.content)
        assertEquals("Search the web for information", jsonObj["description"]?.jsonPrimitive?.content)

        val paramsObj = jsonObj["parameters"]?.jsonObject
        assertNotNull(paramsObj)
        assertEquals("object", paramsObj["type"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<Tool>(jsonString)
        assertEquals(tool, decoded)
    }

    @Test
    fun testContextSerialization() {
        val contexts = listOf(
            Context(
                description = "Current date and time",
                value = "2024-01-15 15:30:00 EST"
            ),
            Context(
                description = "User location",
                value = "New York, NY, USA"
            ),
            Context(
                description = "Multi-line context",
                value = """Line 1
                |Line 2
                |Line 3 with special chars: "quotes" & symbols""".trimMargin()
            )
        )

        contexts.forEach { context ->
            val jsonString = json.encodeToString(context)
            val decoded = json.decodeFromString<Context>(jsonString)

            assertEquals(context.description, decoded.description)
            assertEquals(context.value, decoded.value)
        }
    }

    @Test
    fun testComplexStateSerialization() {
        val complexState = buildJsonObject {
            put("string", "value")
            put("number", 42)
            put("float", 3.14)
            put("boolean", true)
            put("null", JsonNull)
            put("array", JsonArray(listOf(
                JsonPrimitive(1),
                JsonPrimitive("two"),
                JsonPrimitive(false),
                JsonNull
            )))
            put("nested", buildJsonObject {
                put("deep", buildJsonObject {
                    put("deeper", buildJsonObject {
                        put("value", "deeply nested")
                    })
                })
            })
            put("empty_object", buildJsonObject {})
            put("empty_array", JsonArray(emptyList()))
        }

        val input = RunAgentInput(
            threadId = "thread_1",
            runId = "run_1",
            state = complexState
        )

        val jsonString = json.encodeToString(input)
        val decoded = json.decodeFromString<RunAgentInput>(jsonString)

        assertEquals(complexState, decoded.state)
    }

    @Test
    fun testRunAgentParametersMapping() {
        // Simulate what AbstractAgent.prepareRunAgentInput does
        val input = RunAgentInput(
            threadId = "thread_123",
            runId = "custom_run_id",
            state = JsonNull,
            messages = emptyList(),
            tools  = listOf(
                Tool(
                    name = "tool1",
                    description = "Test tool",
                    parameters = buildJsonObject { put("type", "object") }
                )
            ),
            context = listOf(
                Context("key", "value")
            ),
            forwardedProps = buildJsonObject {
                put("custom", "data")
            }
        )

        val jsonString = json.encodeToString(input)
        val decoded = json.decodeFromString<RunAgentInput>(jsonString)

        assertEquals("custom_run_id", decoded.runId)
        assertEquals(1, decoded.tools.size)
        assertEquals(1, decoded.context.size)
        assertNotNull(decoded.forwardedProps)
    }

    @Test
    fun testMessageOrderPreservation() {
        // Test that message order is preserved in serialization
        val messages = (1..10).map { i ->
            if (i % 2 == 0) {
                UserMessage(id = "msg_$i", content = "User message $i")
            } else {
                AssistantMessage(id = "msg_$i", content = "Assistant message $i")
            }
        }

        val input = RunAgentInput(
            threadId = "thread_order",
            runId = "run_order",
            messages = messages
        )

        val jsonString = json.encodeToString(input)
        val decoded = json.decodeFromString<RunAgentInput>(jsonString)

        assertEquals(messages.size, decoded.messages.size)
        messages.zip(decoded.messages).forEach { (original, decoded) ->
            assertEquals(original.id, decoded.id)
            assertEquals(original.content, decoded.content)
        }
    }

    @Test
    fun testToolParameterValidation() {
        // Test various JSON Schema parameter formats
        val schemas = listOf(
            // Simple string parameter
            buildJsonObject {
                put("type", "string")
                put("minLength", 1)
                put("maxLength", 100)
            },
            // Enum parameter
            buildJsonObject {
                put("type", "string")
                put("enum", JsonArray(listOf(
                    JsonPrimitive("option1"),
                    JsonPrimitive("option2"),
                    JsonPrimitive("option3")
                )))
            },
            // Complex nested schema
            buildJsonObject {
                put("type", "object")
                put("properties", buildJsonObject {
                    put("filters", buildJsonObject {
                        put("type", "array")
                        put("items", buildJsonObject {
                            put("type", "object")
                            put("properties", buildJsonObject {
                                put("field", buildJsonObject { put("type", "string") })
                                put("operator", buildJsonObject {
                                    put("type", "string")
                                    put("enum", JsonArray(listOf(
                                        JsonPrimitive("equals"),
                                        JsonPrimitive("contains"),
                                        JsonPrimitive("gt"),
                                        JsonPrimitive("lt")
                                    )))
                                })
                                put("value", buildJsonObject {
                                    put("oneOf", JsonArray(listOf(
                                        buildJsonObject { put("type", "string") },
                                        buildJsonObject { put("type", "number") },
                                        buildJsonObject { put("type", "boolean") }
                                    )))
                                })
                            })
                            put("required", JsonArray(listOf(
                                JsonPrimitive("field"),
                                JsonPrimitive("operator"),
                                JsonPrimitive("value")
                            )))
                        })
                    })
                })
            }
        )

        schemas.forEachIndexed { index, schema ->
            val tool = Tool(
                name = "test_tool_$index",
                description = "Test tool with complex schema",
                parameters = schema
            )

            val jsonString = json.encodeToString(tool)
            try {
                val decoded = json.decodeFromString<Tool>(jsonString)
                assertEquals(tool.name, decoded.name)
                assertEquals(schema, decoded.parameters)
            } catch (e: Exception) {
                fail("Failed to serialize/deserialize tool with schema index $index: ${e.message}")
            }
        }
    }

    @Test
    fun testEmptyArraysVsNullHandling() {
        val input1 = RunAgentInput(
            threadId = "t1",
            runId = "r1",
            messages = emptyList(),
            tools = emptyList(),
            context = emptyList()
        )

        val json1 = json.encodeToString(input1)
        val obj1 = json.parseToJsonElement(json1).jsonObject

        // Empty arrays should be serialized as []
        assertTrue(obj1["messages"]?.jsonArray?.isEmpty() == true)
        assertTrue(obj1["tools"]?.jsonArray?.isEmpty() == true)
        assertTrue(obj1["context"]?.jsonArray?.isEmpty() == true)

        val decoded1 = json.decodeFromString<RunAgentInput>(json1)
        assertEquals(0, decoded1.messages.size)
        assertEquals(0, decoded1.tools.size)
        assertEquals(0, decoded1.context.size)
    }
}