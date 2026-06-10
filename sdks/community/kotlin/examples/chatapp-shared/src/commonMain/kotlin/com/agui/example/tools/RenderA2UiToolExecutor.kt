package com.agui.example.tools

import com.agui.core.types.Tool
import com.agui.tools.AbstractToolExecutor
import com.agui.tools.ToolExecutionContext
import com.agui.tools.ToolExecutionResult
import com.contextable.a2ui4k.agent.A2UiRenderException
import com.contextable.a2ui4k.agent.A2UiRenderTool
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

/**
 * Client-side tool executor that advertises `render_a2ui` to the agent and
 * drives the local [com.contextable.a2ui4k.state.SurfaceStateManager] through
 * [A2UiRenderTool.render] when the agent calls it.
 *
 * Registering this alongside other tools closes the AG-UI tool-call
 * round-trip locally — the middleware no longer has to synthesize
 * `ACTIVITY_SNAPSHOT` + a fake `TOOL_CALL_RESULT`, and `ag_ui_adk`'s
 * pending-tool-call bookkeeping pairs cleanly on the next turn.
 */
class RenderA2UiToolExecutor(
    private val delegate: A2UiRenderTool,
) : AbstractToolExecutor(
    tool = Tool(
        name = delegate.name,
        description = delegate.description,
        parameters = delegate.parameters,
    ),
) {
    override suspend fun executeInternal(context: ToolExecutionContext): ToolExecutionResult {
        val args = try {
            Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
        } catch (error: Exception) {
            return ToolExecutionResult.failure("Invalid JSON arguments: ${error.message}")
        }

        return try {
            val result = delegate.render(args)
            ToolExecutionResult.success(
                result = result,
                message = "A2UI surface rendered",
            )
        } catch (e: A2UiRenderException) {
            ToolExecutionResult.failure(e.message ?: "render_a2ui failed")
        }
    }
}
