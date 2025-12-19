/**
 * A2UI - Agent-to-UI Components for Compose Multiplatform
 *
 * This library provides Compose Multiplatform components for rendering
 * A2UI (Agent-to-UI) surfaces. It implements the component model from
 * the A2UI protocol, enabling AI agents to generate dynamic UIs.
 *
 * ## Quick Start
 *
 * ```kotlin
 * @Composable
 * fun MyScreen(definition: UiDefinition) {
 *     A2UiSurface(
 *         definition = definition,
 *         catalog = CoreCatalog,
 *         onEvent = { event ->
 *             // Handle user interactions
 *         }
 *     )
 * }
 * ```
 *
 * ## Key Components
 *
 * - [A2UiSurface]: Main composable for rendering a UI definition
 * - [CoreCatalog]: Built-in widgets (Text, Column, Row, List, Card, Divider, Icon)
 * - [Catalog]: Widget registry that can be extended with custom widgets
 * - [DataModel]: Reactive data store for path-based bindings
 * - [UiDefinition]: Component tree definition received from AI agent
 *
 * ## Custom Widgets
 *
 * Register custom widgets by creating a [CatalogItem] and combining catalogs:
 *
 * ```kotlin
 * val MyWidget = CatalogItem("MyWidget") { id, data, buildChild, dataContext, onEvent ->
 *     // Compose implementation
 * }
 *
 * val myCatalog = Catalog.of("custom", MyWidget)
 * val combined = CoreCatalog + myCatalog
 * ```
 */
package com.agui.a2ui

// Re-export main types for convenient imports

// Model types
public typealias Component = com.agui.a2ui.model.Component
public typealias UiDefinition = com.agui.a2ui.model.UiDefinition
public typealias UiEvent = com.agui.a2ui.model.UiEvent
public typealias UserActionEvent = com.agui.a2ui.model.UserActionEvent
public typealias DataChangeEvent = com.agui.a2ui.model.DataChangeEvent
public typealias Catalog = com.agui.a2ui.model.Catalog
public typealias CatalogItem = com.agui.a2ui.model.CatalogItem
public typealias DataContext = com.agui.a2ui.model.DataContext

// Data binding
public typealias DataModel = com.agui.a2ui.data.DataModel

// Catalog
public typealias CoreCatalogItems = com.agui.a2ui.catalog.CoreCatalogItems
public typealias AvailableIcons = com.agui.a2ui.catalog.AvailableIcons
