package com.agui.a2ui.catalog.widgets

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.agui.a2ui.model.CatalogItem
import com.agui.a2ui.model.DataChangeEvent
import com.agui.a2ui.model.DataContext
import com.agui.a2ui.model.DataReferenceParser
import com.agui.a2ui.model.EventDispatcher
import com.agui.a2ui.model.LiteralString
import com.agui.a2ui.model.PathString
import kotlinx.serialization.json.JsonObject

/**
 * TextField widget for user text input.
 *
 * JSON Schema:
 * ```json
 * {
 *   "label": {"literalString": "Name"} | {"path": "/labels/name"},
 *   "placeholder": {"literalString": "Enter name..."} (optional),
 *   "value": {"path": "/form/name"} (optional, for two-way binding),
 *   "surfaceId": "surface-id" (required for events)
 * }
 * ```
 */
val TextFieldWidget = CatalogItem(
    name = "TextField"
) { componentId, data, buildChild, dataContext, onEvent ->
    TextFieldWidgetContent(
        componentId = componentId,
        data = data,
        dataContext = dataContext,
        onEvent = onEvent
    )
}

@Composable
private fun TextFieldWidgetContent(
    componentId: String,
    data: JsonObject,
    dataContext: DataContext,
    onEvent: EventDispatcher
) {
    val labelRef = DataReferenceParser.parseString(data["label"])
    val placeholderRef = DataReferenceParser.parseString(data["placeholder"])
    val valueRef = DataReferenceParser.parseString(data["value"])
    val surfaceId = data["surfaceId"]?.let {
        DataReferenceParser.parseString(it)
    }?.let {
        when (it) {
            is LiteralString -> it.value
            is PathString -> dataContext.getString(it.path)
            else -> null
        }
    } ?: ""

    val label = when (labelRef) {
        is LiteralString -> labelRef.value
        is PathString -> dataContext.getString(labelRef.path) ?: ""
        else -> ""
    }

    val placeholder = when (placeholderRef) {
        is LiteralString -> placeholderRef.value
        is PathString -> dataContext.getString(placeholderRef.path)
        else -> null
    }

    // Get initial value from data context if bound
    val initialValue = when (valueRef) {
        is PathString -> dataContext.getString(valueRef.path) ?: ""
        is LiteralString -> valueRef.value
        else -> ""
    }

    var textValue by remember(initialValue) { mutableStateOf(initialValue) }

    OutlinedTextField(
        value = textValue,
        onValueChange = { newValue ->
            textValue = newValue
            // Update data context and fire event if bound
            if (valueRef is PathString) {
                dataContext.update(valueRef.path, newValue)
                onEvent(
                    DataChangeEvent(
                        surfaceId = surfaceId,
                        path = valueRef.path,
                        value = newValue
                    )
                )
            }
        },
        label = if (label.isNotEmpty()) {
            { Text(label) }
        } else null,
        placeholder = placeholder?.let {
            { Text(it) }
        },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true
    )
}
