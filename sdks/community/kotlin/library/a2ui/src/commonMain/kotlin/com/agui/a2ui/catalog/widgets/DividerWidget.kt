package com.agui.a2ui.catalog.widgets

import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agui.a2ui.model.CatalogItem
import com.agui.a2ui.model.DataContext
import com.agui.a2ui.model.DataReferenceParser
import com.agui.a2ui.model.LiteralString
import com.agui.a2ui.model.PathString
import kotlinx.serialization.json.JsonObject

/**
 * Divider widget that displays a thin line to separate content.
 *
 * JSON Schema:
 * ```json
 * {
 *   "axis": "horizontal" | "vertical" (optional, default: horizontal)
 * }
 * ```
 */
val DividerWidget = CatalogItem(
    name = "Divider"
) { componentId, data, buildChild, dataContext, onEvent ->
    DividerWidgetContent(data = data, dataContext = dataContext)
}

@Composable
private fun DividerWidgetContent(
    data: JsonObject,
    dataContext: DataContext
) {
    val axisRef = DataReferenceParser.parseString(data["axis"])
    val axis = when (axisRef) {
        is LiteralString -> axisRef.value
        is PathString -> dataContext.getString(axisRef.path)
        else -> null
    }

    val isVertical = axis?.lowercase() == "vertical"

    if (isVertical) {
        VerticalDivider(
            modifier = Modifier
                .fillMaxHeight()
                .width(1.dp)
        )
    } else {
        HorizontalDivider(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
        )
    }
}
