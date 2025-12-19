package com.agui.a2ui.catalog.widgets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import com.agui.a2ui.model.CatalogItem
import com.agui.a2ui.model.ChildBuilder
import com.agui.a2ui.model.ChildrenReference
import com.agui.a2ui.model.DataContext
import com.agui.a2ui.model.DataReferenceParser
import com.agui.a2ui.model.LiteralString
import com.agui.a2ui.model.PathString
import kotlinx.serialization.json.JsonObject

/**
 * CompositionLocal for passing scoped data context to template children.
 */
val LocalScopedDataContext = compositionLocalOf<DataContext?> { null }

/**
 * CompositionLocal for passing the current template item key to children.
 * This allows components like Button to build sourceComponentId with item suffix.
 * Example: "template-book-button:item1"
 */
val LocalTemplateItemKey = compositionLocalOf<String?> { null }

/**
 * List widget that displays a scrollable list of children.
 *
 * JSON Schema:
 * ```json
 * {
 *   "children": {"explicitList": ["child1", "child2"]},
 *   "direction": "vertical" | "horizontal" (optional, default: vertical),
 *   "alignment": "start" | "center" | "end" (optional)
 * }
 * ```
 *
 * Or with template (for data-driven lists):
 * ```json
 * {
 *   "children": {"template": {"componentId": "item-template", "dataBinding": "/items"}},
 *   "direction": "vertical" | "horizontal" (optional, default: vertical)
 * }
 * ```
 */
val ListWidget = CatalogItem(
    name = "List"
) { componentId, data, buildChild, dataContext, onEvent ->
    ListWidgetContent(data = data, buildChild = buildChild, dataContext = dataContext)
}

@Composable
private fun ListWidgetContent(
    data: JsonObject,
    buildChild: ChildBuilder,
    dataContext: DataContext
) {
    val childrenRef = DataReferenceParser.parseChildren(data["children"])

    val directionRef = DataReferenceParser.parseString(data["direction"])
    val direction = when (directionRef) {
        is LiteralString -> directionRef.value
        is PathString -> dataContext.getString(directionRef.path)
        else -> null
    }

    val alignmentRef = DataReferenceParser.parseString(data["alignment"])
    val alignment = when (alignmentRef) {
        is LiteralString -> alignmentRef.value
        is PathString -> dataContext.getString(alignmentRef.path)
        else -> null
    }

    val isHorizontal = direction?.lowercase() == "horizontal"

    when (childrenRef) {
        is ChildrenReference.ExplicitList -> {
            RenderExplicitChildren(
                children = childrenRef.componentIds,
                buildChild = buildChild,
                isHorizontal = isHorizontal,
                alignment = alignment
            )
        }
        is ChildrenReference.Template -> {
            RenderTemplateChildren(
                templateId = childrenRef.componentId,
                dataBinding = childrenRef.dataBinding,
                buildChild = buildChild,
                dataContext = dataContext,
                isHorizontal = isHorizontal,
                alignment = alignment
            )
        }
        null -> {
            // No children - render empty
        }
    }
}

@Composable
private fun RenderExplicitChildren(
    children: List<String>,
    buildChild: ChildBuilder,
    isHorizontal: Boolean,
    alignment: String?
) {
    if (isHorizontal) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = parseVerticalAlignment(alignment)
        ) {
            children.forEach { childId ->
                buildChild(childId)
            }
        }
    } else {
        Column(
            verticalArrangement = Arrangement.spacedBy(8.dp),
            horizontalAlignment = parseHorizontalAlignment(alignment)
        ) {
            children.forEach { childId ->
                buildChild(childId)
            }
        }
    }
}

@Composable
private fun RenderTemplateChildren(
    templateId: String,
    dataBinding: String,
    buildChild: ChildBuilder,
    dataContext: DataContext,
    isHorizontal: Boolean,
    alignment: String?
) {
    // Try array first, then fall back to object keys (like Flutter GenUI)
    val arraySize = dataContext.getArraySize(dataBinding)
    val objectKeys = if (arraySize == null) dataContext.getObjectKeys(dataBinding) else null

    println("Debug: (ListWidget) RenderTemplateChildren dataBinding=$dataBinding arraySize=$arraySize objectKeys=$objectKeys")

    // Determine iteration keys - either array indices or object keys
    val itemKeys: List<String> = when {
        arraySize != null -> (0 until arraySize).map { it.toString() }
        objectKeys != null -> objectKeys
        else -> emptyList()
    }

    println("Debug: (ListWidget) itemKeys=$itemKeys")

    if (isHorizontal) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = parseVerticalAlignment(alignment)
        ) {
            for (key in itemKeys) {
                // Create a scoped data context for this item using the key
                val scopedContext = dataContext.withBasePath("$dataBinding/$key")

                // Provide the scoped context and item key for this template instance
                CompositionLocalProvider(
                    LocalScopedDataContext provides scopedContext,
                    LocalTemplateItemKey provides key
                ) {
                    buildChild(templateId)
                }
            }
        }
    } else {
        Column(
            verticalArrangement = Arrangement.spacedBy(8.dp),
            horizontalAlignment = parseHorizontalAlignment(alignment)
        ) {
            for (key in itemKeys) {
                // Create a scoped data context for this item using the key
                val scopedContext = dataContext.withBasePath("$dataBinding/$key")

                // Provide the scoped context and item key for this template instance
                CompositionLocalProvider(
                    LocalScopedDataContext provides scopedContext,
                    LocalTemplateItemKey provides key
                ) {
                    buildChild(templateId)
                }
            }
        }
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

private fun parseVerticalAlignment(alignment: String?): Alignment.Vertical {
    return when (alignment?.lowercase()) {
        "top", "start" -> Alignment.Top
        "center" -> Alignment.CenterVertically
        "bottom", "end" -> Alignment.Bottom
        else -> Alignment.Top
    }
}
