package com.agui.a2ui.catalog.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.agui.a2ui.model.CatalogItem
import com.agui.a2ui.model.ChildBuilder
import com.agui.a2ui.model.DataContext
import com.agui.a2ui.model.DataReferenceParser
import com.agui.a2ui.model.LiteralString
import com.agui.a2ui.model.PathString
import com.agui.a2ui.render.LocalUiDefinition
import kotlinx.serialization.json.JsonObject

/**
 * Row widget that arranges children horizontally.
 *
 * JSON Schema:
 * ```json
 * {
 *   "children": {"explicitList": ["child1", "child2"]},
 *   "distribution": "start" | "center" | "end" | "spaceBetween" | "spaceAround" | "spaceEvenly" (optional),
 *   "alignment": "top" | "center" | "bottom" (optional)
 * }
 * ```
 */
val RowWidget = CatalogItem(
    name = "Row"
) { componentId, data, buildChild, dataContext, onEvent ->
    RowWidgetContent(data = data, buildChild = buildChild, dataContext = dataContext)
}

@Composable
private fun RowWidgetContent(
    data: JsonObject,
    buildChild: ChildBuilder,
    dataContext: DataContext
) {
    val childrenRef = DataReferenceParser.parseComponentArray(data["children"])
    val children = childrenRef?.componentIds ?: emptyList()

    val distributionRef = DataReferenceParser.parseString(data["distribution"])
    val distribution = when (distributionRef) {
        is LiteralString -> distributionRef.value
        is PathString -> dataContext.getString(distributionRef.path)
        else -> null
    }

    val alignmentRef = DataReferenceParser.parseString(data["alignment"])
    val alignment = when (alignmentRef) {
        is LiteralString -> alignmentRef.value
        is PathString -> dataContext.getString(alignmentRef.path)
        else -> null
    }

    val definition = LocalUiDefinition.current

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = parseHorizontalArrangement(distribution),
        verticalAlignment = parseVerticalAlignment(alignment)
    ) {
        children.forEach { childId ->
            val weight = definition?.components?.get(childId)?.weight
            BuildWeightedChild(weight = weight, buildChild = buildChild, childId = childId)
        }
    }
}

/**
 * Helper that wraps a child with Modifier.weight() if weight is specified.
 * Similar to Flutter GenUI's buildWeightedChild pattern.
 */
@Composable
private fun RowScope.BuildWeightedChild(
    weight: Int?,
    buildChild: ChildBuilder,
    childId: String
) {
    if (weight != null && weight > 0) {
        Box(modifier = Modifier.weight(weight.toFloat())) {
            buildChild(childId)
        }
    } else {
        buildChild(childId)
    }
}

private fun parseHorizontalArrangement(distribution: String?): Arrangement.Horizontal {
    return when (distribution?.lowercase()) {
        "start", "left" -> Arrangement.Start
        "center" -> Arrangement.Center
        "end", "right" -> Arrangement.End
        "spacebetween" -> Arrangement.SpaceBetween
        "spacearound" -> Arrangement.SpaceAround
        "spaceevenly" -> Arrangement.SpaceEvenly
        else -> Arrangement.Start
    }
}

private fun parseVerticalAlignment(alignment: String?): Alignment.Vertical {
    return when (alignment?.lowercase()) {
        "top", "start" -> Alignment.Top
        "center" -> Alignment.CenterVertically
        "bottom", "end" -> Alignment.Bottom
        else -> Alignment.Top
    }
}
