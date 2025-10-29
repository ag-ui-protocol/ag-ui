package com.agui.example.tools

import com.agui.core.types.Tool
import com.agui.core.types.ToolCall
import com.agui.tools.AbstractToolExecutor
import com.agui.tools.ToolExecutionContext
import com.agui.tools.ToolExecutionResult
import com.agui.tools.ToolValidationResult
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Tool executor that changes the visual background of the chat demos.
 *
 * The tool receives color information from the agent and forwards it to the
 * host application through the provided [BackgroundChangeHandler]. Each demo
 * is responsible for interpreting the [BackgroundStyle] in a platform
 * specific way (e.g. changing a Compose surface colour or a SwiftUI
 * background view).
 */
class ChangeBackgroundToolExecutor(
    private val backgroundChangeHandler: BackgroundChangeHandler
) : AbstractToolExecutor(
    tool = Tool(
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
        }
    )
) {

    override suspend fun executeInternal(context: ToolExecutionContext): ToolExecutionResult {
        val args = try {
            Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
        } catch (error: Exception) {
            return ToolExecutionResult.failure("Invalid JSON arguments: ${error.message}")
        }

        val reset = args["reset"]?.jsonPrimitive?.booleanOrNull ?: false
        if (reset) {
            backgroundChangeHandler.applyBackground(BackgroundStyle.Default)
            return ToolExecutionResult.success(
                result = buildJsonObject {
                    put("status", "reset")
                },
                message = "Background reset to default"
            )
        }

        val color = args["color"]?.jsonPrimitive?.content
            ?: return ToolExecutionResult.failure("Missing required parameter: color")

        if (!color.matches(HEX_COLOUR_REGEX)) {
            return ToolExecutionResult.failure(
                "Invalid colour value: $color. Expected formats: #RRGGBB or #RRGGBBAA"
            )
        }

        val description = args["description"]?.jsonPrimitive?.content
        val style = BackgroundStyle(
            colorHex = color,
            description = description
        )

        return try {
            backgroundChangeHandler.applyBackground(style)
            ToolExecutionResult.success(
                result = buildJsonObject {
                    put("status", "applied")
                    put("color", color)
                    if (description != null) {
                        put("description", description)
                    }
                },
                message = "Background updated"
            )
        } catch (error: Exception) {
            ToolExecutionResult.failure("Failed to change background: ${error.message}")
        }
    }

    override fun validate(toolCall: ToolCall): ToolValidationResult {
        val args = try {
            Json.parseToJsonElement(toolCall.function.arguments).jsonObject
        } catch (error: Exception) {
            return ToolValidationResult.failure("Invalid JSON arguments: ${error.message}")
        }

        val reset = args["reset"]?.jsonPrimitive?.booleanOrNull ?: false
        if (reset) {
            return ToolValidationResult.success()
        }

        val color = args["color"]?.jsonPrimitive?.content
            ?: return ToolValidationResult.failure("Missing required parameter: color")

        return if (color.matches(HEX_COLOUR_REGEX)) {
            ToolValidationResult.success()
        } else {
            ToolValidationResult.failure(
                "Invalid colour value: $color. Expected formats: #RRGGBB or #RRGGBBAA"
            )
        }
    }

    override fun getMaxExecutionTimeMs(): Long? = 10_000L

    private companion object {
        val HEX_COLOUR_REGEX = Regex("^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
    }
}

/**
 * Representation of a visual background request sent from the agent.
 */
data class BackgroundStyle(
    val colorHex: String?,
    val description: String? = null
) {
    companion object {
        val Default = BackgroundStyle(colorHex = null, description = null)
    }
}

/**
 * Implemented by host applications to react to [ChangeBackgroundToolExecutor]
 * requests.
 */
interface BackgroundChangeHandler {
    suspend fun applyBackground(style: BackgroundStyle)
}
