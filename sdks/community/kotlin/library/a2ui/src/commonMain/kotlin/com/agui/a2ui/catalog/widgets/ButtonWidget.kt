package com.agui.a2ui.catalog.widgets

import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import com.agui.a2ui.model.CatalogItem
import com.agui.a2ui.model.ChildBuilder
import com.agui.a2ui.model.DataContext
import com.agui.a2ui.model.DataReferenceParser
import com.agui.a2ui.model.EventDispatcher
import com.agui.a2ui.model.LiteralBoolean
import com.agui.a2ui.model.LiteralString
import com.agui.a2ui.model.PathBoolean
import com.agui.a2ui.model.PathString
import com.agui.a2ui.model.UserActionEvent
import com.agui.a2ui.render.LocalUiDefinition
import kotlinx.datetime.Clock
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Button widget for user actions.
 *
 * Matches Flutter GenUI Button schema:
 * - `child`: Component ID reference (e.g., to a Text widget) - preferred
 * - `label`: Direct label string - fallback for backwards compatibility
 * - `primary`: Boolean for primary button styling
 * - `action`: Action to dispatch on click
 *
 * JSON Schema:
 * ```json
 * {
 *   "child": "button-text-id",
 *   "primary": true,
 *   "action": {"name": "submit", "context": [...]}
 * }
 * ```
 */
val ButtonWidget = CatalogItem(
    name = "Button"
) { componentId, data, buildChild, dataContext, onEvent ->
    ButtonWidgetContent(
        componentId = componentId,
        data = data,
        buildChild = buildChild,
        dataContext = dataContext,
        onEvent = onEvent
    )
}

@Composable
private fun ButtonWidgetContent(
    componentId: String,
    data: JsonObject,
    buildChild: ChildBuilder,
    dataContext: DataContext,
    onEvent: EventDispatcher
) {
    // Child component reference (preferred, matches Flutter GenUI)
    val childRef = DataReferenceParser.parseString(data["child"])
    val childId = when (childRef) {
        is LiteralString -> childRef.value
        is PathString -> dataContext.getString(childRef.path)
        else -> null
    }

    // Fallback to label for backwards compatibility
    val labelRef = DataReferenceParser.parseString(data["label"])
    val label = when (labelRef) {
        is LiteralString -> labelRef.value
        is PathString -> dataContext.getString(labelRef.path)
        else -> null
    }

    // Primary button styling
    val primaryRef = DataReferenceParser.parseBoolean(data["primary"])
    val isPrimary = when (primaryRef) {
        is LiteralBoolean -> primaryRef.value
        is PathBoolean -> dataContext.getBoolean(primaryRef.path) ?: false
        else -> false
    }

    val actionData = data["action"]?.jsonObject

    // Get surfaceId from UiDefinition (not from component data)
    val uiDefinition = LocalUiDefinition.current
    val surfaceId = uiDefinition?.surfaceId ?: "default"

    // Get template item key for sourceComponentId suffix
    val templateItemKey = LocalTemplateItemKey.current

    val onClick: () -> Unit = {
        val actionName = actionData?.get("name")?.jsonPrimitive?.content ?: "click"

        // Resolve action.context array (Flutter GenUI style)
        val contextArray = actionData?.get("context")?.jsonArray
        val resolvedContext = resolveContext(contextArray, dataContext)

        // Build sourceComponentId with item suffix (e.g., "template-book-button:item1")
        val sourceComponentId = if (templateItemKey != null) {
            "$componentId:item$templateItemKey"
        } else {
            componentId
        }

        // Generate ISO8601 timestamp
        val timestamp = getCurrentIso8601Timestamp()

        onEvent(
            UserActionEvent(
                name = actionName,
                surfaceId = surfaceId,
                sourceComponentId = sourceComponentId,
                timestamp = timestamp,
                context = resolvedContext
            )
        )
    }

    // Match Flutter GenUI: ElevatedButton with colors based on primary
    // primary=true: colorScheme.primary background, onPrimary foreground
    // primary=false: colorScheme.surface background, onSurface foreground
    val colors = if (isPrimary) {
        ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary
        )
    } else {
        ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.surface,
            contentColor = MaterialTheme.colorScheme.onSurface
        )
    }

    Button(
        onClick = onClick,
        colors = colors
    ) {
        when {
            // Prefer child component reference (Flutter GenUI style)
            childId != null -> buildChild(childId)
            // Fallback to label text
            label != null -> Text(label)
            // Default fallback
            else -> Text("Button")
        }
    }
}

/**
 * Resolves action context array by evaluating path bindings against the DataContext.
 *
 * Matches Flutter GenUI's resolveContext pattern:
 * - Each context entry has a "key" and "value"
 * - Value can be: path (resolved from DataContext), literalString, literalNumber, literalBoolean
 *
 * @param contextArray The action.context JsonArray from the button definition
 * @param dataContext The current DataContext for resolving path bindings
 * @return JsonObject with resolved key-value pairs, or null if no context
 */
private fun resolveContext(contextArray: JsonArray?, dataContext: DataContext): JsonObject? {
    if (contextArray == null || contextArray.isEmpty()) return null

    val resolved = mutableMapOf<String, JsonElement>()

    for (entry in contextArray) {
        val entryObj = entry as? JsonObject ?: continue
        val key = entryObj["key"]?.jsonPrimitive?.content ?: continue
        val value = entryObj["value"]?.jsonObject ?: continue

        val resolvedValue: JsonElement? = when {
            // Path binding - resolve from DataContext
            value.containsKey("path") -> {
                val path = value["path"]?.jsonPrimitive?.content ?: ""
                // Try to get value from data context
                dataContext.getString(path)?.let { JsonPrimitive(it) }
                    ?: dataContext.getNumber(path)?.let { JsonPrimitive(it) }
                    ?: dataContext.getBoolean(path)?.let { JsonPrimitive(it) }
            }
            // Literal string
            value.containsKey("literalString") -> {
                value["literalString"]?.jsonPrimitive?.content?.let { JsonPrimitive(it) }
            }
            // Literal number
            value.containsKey("literalNumber") -> {
                value["literalNumber"]?.jsonPrimitive?.doubleOrNull?.let { JsonPrimitive(it) }
            }
            // Literal boolean
            value.containsKey("literalBoolean") -> {
                value["literalBoolean"]?.jsonPrimitive?.booleanOrNull?.let { JsonPrimitive(it) }
            }
            else -> null
        }

        if (resolvedValue != null) {
            resolved[key] = resolvedValue
        }
    }

    return if (resolved.isNotEmpty()) JsonObject(resolved) else null
}

/**
 * Gets the current timestamp in ISO8601 format.
 * Example: "2025-12-17T02:00:23.936Z"
 */
private fun getCurrentIso8601Timestamp(): String {
    val now = Clock.System.now()
    return now.toString() // Instant.toString() produces ISO8601 format
}
