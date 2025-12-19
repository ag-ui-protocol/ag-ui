package com.agui.a2ui.catalog.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
 * Column widget that arranges children vertically.
 *
 * JSON Schema:
 * ```json
 * {
 *   "children": {"explicitList": ["child1", "child2"]},
 *   "distribution": "start" | "center" | "end" | "spaceBetween" | "spaceAround" | "spaceEvenly" (optional),
 *   "alignment": "start" | "center" | "end" (optional)
 * }
 * ```
 */
val ColumnWidget = CatalogItem(
    name = "Column"
) { componentId, data, buildChild, dataContext, onEvent ->
    ColumnWidgetContent(data = data, buildChild = buildChild, dataContext = dataContext)
}

@Composable
private fun ColumnWidgetContent(
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

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = parseVerticalArrangement(distribution),
        horizontalAlignment = parseHorizontalAlignment(alignment)
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
private fun ColumnScope.BuildWeightedChild(
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

private fun parseVerticalArrangement(distribution: String?): Arrangement.Vertical {
    return when (distribution?.lowercase()) {
        "start", "top" -> Arrangement.Top
        "center" -> Arrangement.Center
        "end", "bottom" -> Arrangement.Bottom
        "spacebetween" -> Arrangement.SpaceBetween
        "spacearound" -> Arrangement.SpaceAround
        "spaceevenly" -> Arrangement.SpaceEvenly
        else -> Arrangement.Top
    }
}

private fun parseHorizontalAlignment(alignment: String?): Alignment.Horizontal {
    return when (alignment?.lowercase()) {
        "start", "left" -> Alignment.Start
        "center" -> Alignment.CenterHorizontally
        "end", "right" -> Alignment.End
        else -> Alignment.Start
    }
}
