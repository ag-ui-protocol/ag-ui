package com.agui.a2ui.model

import kotlinx.serialization.Serializable

/**
 * Represents the complete state of a UI surface in the A2UI protocol.
 *
 * A UiDefinition contains all the components that make up a surface,
 * along with metadata about which component is the root and which
 * catalog should be used for rendering.
 *
 * @property surfaceId Unique identifier for this surface
 * @property components Map of component ID to Component definitions
 * @property root The ID of the root component to start rendering from
 * @property catalogId Optional identifier of the catalog to use for this surface
 */
@Serializable
data class UiDefinition(
    val surfaceId: String,
    val components: Map<String, Component> = emptyMap(),
    val root: String? = null,
    val catalogId: String? = null
) {
    /**
     * Returns the root component if it exists.
     */
    val rootComponent: Component?
        get() = root?.let { components[it] }

    /**
     * Creates a copy with updated components.
     */
    fun withComponents(newComponents: Map<String, Component>): UiDefinition =
        copy(components = components + newComponents)

    /**
     * Creates a copy with the root set.
     */
    fun withRoot(rootId: String, catalog: String? = null): UiDefinition =
        copy(root = rootId, catalogId = catalog ?: catalogId)

    companion object {
        /**
         * Creates an empty UiDefinition for a surface.
         */
        fun empty(surfaceId: String): UiDefinition = UiDefinition(surfaceId = surfaceId)
    }
}
