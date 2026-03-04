package com.agui.tests

import com.agui.core.types.*
import kotlinx.serialization.json.*
import kotlinx.serialization.encodeToString
import kotlin.test.Test

class ToolSerializationDebugTest {
    
    @Test
    fun testChangeBackgroundToolSerialization() {
        // Create the change_background tool definition to ensure serialization stays consistent
        val backgroundTool = Tool(
            name = "change_background",
            description = "Update the application's background or surface colour",
            parameters = buildJsonObject {
                put("type", "object")
                putJsonObject("properties") {
                    putJsonObject("color") {
                        put("type", "string")
                        put(
                            "description",
                            "Colour in hex format (e.g. #RRGGBB or #RRGGBBAA) to apply to the background"
                        )
                    }
                    putJsonObject("description") {
                        put("type", "string")
                        put(
                            "description",
                            "Optional human readable description of the new background"
                        )
                    }
                    putJsonObject("reset") {
                        put("type", "boolean")
                        put(
                            "description",
                            "Set to true to reset the background to the default theme"
                        )
                        put("default", JsonPrimitive(false))
                    }
                }
                putJsonArray("required") {
                    add("color")
                }
            }
        )

        // Serialize just the tool
        val toolJson = AgUiJson.encodeToString(backgroundTool)
        println("\n=== Tool JSON ===")
        println(toolJson)
        
        // Create a minimal RunAgentInput
        val runInput = RunAgentInput(
            threadId = "thread_1750919849810",
            runId = "run_1750920834023",
            state = JsonObject(emptyMap()),
            messages = listOf(
                UserMessage(
                    id = "usr_1750920834023",
                    content = "delete user data"
                )
            ),
            tools = listOf(backgroundTool),
            context = emptyList(),
            forwardedProps = JsonObject(emptyMap())
        )
        
        // Serialize the full input
        val inputJson = AgUiJson.encodeToString(runInput)
        println("\n=== Full RunAgentInput JSON (minified) ===")
        println(inputJson)
        
        // Pretty print for readability
        val prettyJson = Json { 
            prettyPrint = true 
            serializersModule = AgUiJson.serializersModule
            ignoreUnknownKeys = true
            isLenient = true
            encodeDefaults = true
            explicitNulls = false
        }
        println("\n=== Pretty printed RunAgentInput ===")
        println(prettyJson.encodeToString(runInput))
        
        // Extract and show just the tools array
        val parsed = prettyJson.parseToJsonElement(inputJson).jsonObject
        val toolsArray = parsed["tools"]?.jsonArray
        println("\n=== Tools array only ===")
        println(prettyJson.encodeToString(toolsArray))
    }
}