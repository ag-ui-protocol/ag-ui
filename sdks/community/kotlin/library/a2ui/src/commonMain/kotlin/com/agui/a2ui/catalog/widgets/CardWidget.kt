package com.agui.a2ui.catalog.widgets

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agui.a2ui.model.CatalogItem
import com.agui.a2ui.model.ChildBuilder
import com.agui.a2ui.model.DataReferenceParser
import kotlinx.serialization.json.JsonObject

/**
 * Card widget that wraps a child component in a Material 3 Card.
 *
 * Matches Flutter GenUI Card:
 * - Uses surface color from theme
 * - Applies 8dp internal padding around child
 *
 * JSON Schema:
 * ```json
 * {
 *   "child": "childComponentId"
 * }
 * ```
 */
val CardWidget = CatalogItem(
    name = "Card"
) { componentId, data, buildChild, dataContext, onEvent ->
    CardWidgetContent(data = data, buildChild = buildChild)
}

@Composable
private fun CardWidgetContent(
    data: JsonObject,
    buildChild: ChildBuilder
) {
    val childRef = DataReferenceParser.parseComponentRef(data["child"])
    val childId = childRef?.componentId

    // Match Flutter GenUI: Card with surface color and internal padding
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        // Internal padding around child (EdgeInsets.all(8.0) in Flutter)
        Box(modifier = Modifier.padding(8.dp)) {
            if (childId != null) {
                buildChild(childId)
            }
        }
    }
}
