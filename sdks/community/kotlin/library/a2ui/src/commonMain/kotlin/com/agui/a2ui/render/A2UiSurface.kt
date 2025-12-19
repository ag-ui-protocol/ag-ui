package com.agui.a2ui.render

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import com.agui.a2ui.catalog.widgets.LocalScopedDataContext
import com.agui.a2ui.data.DataModel
import com.agui.a2ui.data.rememberDataModel
import com.agui.a2ui.model.Catalog
import com.agui.a2ui.model.DataContext
import com.agui.a2ui.model.UiDefinition
import com.agui.a2ui.model.UiEvent

/**
 * CompositionLocal providing access to the current UiDefinition.
 * This allows layout widgets to look up child component properties like weight.
 */
val LocalUiDefinition = compositionLocalOf<UiDefinition?> { null }

/**
 * Main composable for rendering an A2UI surface.
 *
 * A2UiSurface takes a UiDefinition (the component tree) and renders it
 * using widgets from the provided catalog. User interactions are reported
 * via the onEvent callback.
 *
 * @param definition The UI definition containing the component tree to render
 * @param modifier Modifier for the surface container
 * @param dataModel The data model for resolving path bindings (defaults to a new instance)
 * @param catalog The widget catalog to use for rendering (defaults to CoreCatalog)
 * @param onEvent Callback for user interaction events
 */
@Composable
fun A2UiSurface(
    definition: UiDefinition,
    modifier: Modifier = Modifier,
    dataModel: DataModel = rememberDataModel(),
    catalog: Catalog,
    onEvent: (UiEvent) -> Unit = {}
) {
    val dataContext = remember(dataModel) { dataModel.createContext() }

    CompositionLocalProvider(LocalUiDefinition provides definition) {
        Box(modifier = modifier) {
            val rootId = definition.root
            if (rootId != null) {
                ComponentBuilder(
                    componentId = rootId,
                    definition = definition,
                    catalog = catalog,
                    dataContext = dataContext,
                    surfaceId = definition.surfaceId,
                    onEvent = onEvent
                )
            } else {
                // No root component defined yet
                EmptyState()
            }
        }
    }
}

/**
 * Builds a single component from the definition by ID.
 *
 * This recursively builds the component tree by resolving child references.
 * When a scoped data context is available (e.g., within a template list),
 * it uses that instead of the default context.
 */
@Composable
internal fun ComponentBuilder(
    componentId: String,
    definition: UiDefinition,
    catalog: Catalog,
    dataContext: DataContext,
    surfaceId: String,
    onEvent: (UiEvent) -> Unit
) {
    // Use scoped context from template rendering if available, otherwise use default
    val scopedContext = LocalScopedDataContext.current
    val effectiveContext = scopedContext ?: dataContext

    val component = definition.components[componentId]
    if (component == null) {
        MissingComponent(componentId)
        return
    }

    val widgetType = component.widgetType
    val widgetData = component.widgetData

    if (widgetType == null || widgetData == null) {
        InvalidComponent(componentId)
        return
    }

    val catalogItem = catalog[widgetType]
    if (catalogItem == null) {
        UnknownWidget(widgetType, componentId)
        return
    }

    // Build child function that recursively builds children
    // Note: Children inherit the effective context (scoped or default)
    val buildChild: @Composable (String) -> Unit = { childId ->
        ComponentBuilder(
            componentId = childId,
            definition = definition,
            catalog = catalog,
            dataContext = effectiveContext,
            surfaceId = surfaceId,
            onEvent = onEvent
        )
    }

    // Wrap event dispatcher to include surface ID
    val eventDispatcher: (UiEvent) -> Unit = { event ->
        onEvent(event)
    }

    // Render the widget with the effective context
    catalogItem.compose(
        componentId,
        widgetData,
        buildChild,
        effectiveContext,
        eventDispatcher
    )
}

/**
 * Placeholder for empty surfaces (no root defined).
 */
@Composable
private fun EmptyState() {
    // Empty composable - surface has no content yet
}

/**
 * Error state when a referenced component doesn't exist.
 */
@Composable
private fun MissingComponent(componentId: String) {
    Text("Missing component: $componentId")
}

/**
 * Error state when a component has invalid structure.
 */
@Composable
private fun InvalidComponent(componentId: String) {
    Text("Invalid component: $componentId")
}

/**
 * Error state when a widget type isn't in the catalog.
 */
@Composable
private fun UnknownWidget(widgetType: String, componentId: String) {
    Text("Unknown widget '$widgetType' for component: $componentId")
}
