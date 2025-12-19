package com.agui.a2ui.state

import com.agui.a2ui.data.DataModel
import com.agui.a2ui.model.A2UiActivityContent
import com.agui.a2ui.model.A2UiOperation
import com.agui.a2ui.model.BeginRendering
import com.agui.a2ui.model.Component
import com.agui.a2ui.model.ComponentDef
import com.agui.a2ui.model.DataEntry
import com.agui.a2ui.model.DataModelUpdate
import com.agui.a2ui.model.DeleteSurface
import com.agui.a2ui.model.SurfaceUpdate
import com.agui.a2ui.model.UiDefinition
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/**
 * Manages the state of A2UI surfaces.
 *
 * Receives A2UI operations from ACTIVITY_SNAPSHOT/DELTA events and builds
 * [UiDefinition] instances that can be rendered by [A2UiSurface].
 *
 * Usage:
 * ```kotlin
 * val manager = SurfaceStateManager()
 *
 * // Process operations from activity events
 * manager.processSnapshot(messageId, activityContent)
 * manager.processDelta(messageId, jsonPatch)
 *
 * // Get current surfaces for rendering
 * val surfaces = manager.getSurfaces()
 * ```
 */
class SurfaceStateManager {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    /**
     * Internal state for a single surface.
     */
    private data class SurfaceState(
        val surfaceId: String,
        var root: String? = null,
        var styles: JsonObject? = null,
        val components: MutableMap<String, Component> = mutableMapOf(),
        val dataModel: DataModel = DataModel()
    ) {
        fun toUiDefinition(): UiDefinition = UiDefinition(
            surfaceId = surfaceId,
            components = components.toMap(),
            root = root
        )
    }

    private val surfaces = mutableMapOf<String, SurfaceState>()

    /**
     * Processes an ACTIVITY_SNAPSHOT event for a2ui-surface.
     *
     * @param messageId The message ID associated with this activity
     * @param content The activity content containing operations
     */
    fun processSnapshot(messageId: String, content: JsonElement) {
        val contentObj = content.jsonObject
        val operationsArray = contentObj["operations"]?.jsonArray ?: return

        for (opElement in operationsArray) {
            val opObj = opElement.jsonObject
            processOperationObject(opObj)
        }
    }

    /**
     * Processes an ACTIVITY_DELTA event for a2ui-surface.
     *
     * The patch contains JSON Patch operations that may add new operations
     * to the surface state.
     *
     * @param messageId The message ID associated with this activity
     * @param patch The JSON Patch array
     */
    fun processDelta(messageId: String, patch: JsonArray) {
        for (patchOp in patch) {
            val patchObj = patchOp.jsonObject
            val op = (patchObj["op"] as? kotlinx.serialization.json.JsonPrimitive)?.content
            val path = (patchObj["path"] as? kotlinx.serialization.json.JsonPrimitive)?.content
            val value = patchObj["value"]

            // Handle add operations to /operations/-
            if (op == "add" && path?.startsWith("/operations/") == true && value != null) {
                val opObj = value.jsonObject
                processOperationObject(opObj)
            }
        }
    }

    /**
     * Processes a raw operation JSON object.
     */
    private fun processOperationObject(opObj: JsonObject) {
        when {
            opObj.containsKey("beginRendering") -> {
                val data = opObj["beginRendering"]!!.jsonObject
                handleBeginRendering(data)
            }
            opObj.containsKey("surfaceUpdate") -> {
                val data = opObj["surfaceUpdate"]!!.jsonObject
                handleSurfaceUpdate(data)
            }
            opObj.containsKey("dataModelUpdate") -> {
                val data = opObj["dataModelUpdate"]!!.jsonObject
                handleDataModelUpdate(data)
            }
            opObj.containsKey("deleteSurface") -> {
                val data = opObj["deleteSurface"]!!.jsonObject
                handleDeleteSurface(data)
            }
        }
    }

    private fun handleBeginRendering(data: JsonObject) {
        val surfaceId = (data["surfaceId"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return
        val root = (data["root"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        val styles = data["styles"]?.jsonObject

        val state = surfaces.getOrPut(surfaceId) { SurfaceState(surfaceId) }
        state.root = root
        state.styles = styles
    }

    private fun handleSurfaceUpdate(data: JsonObject) {
        val surfaceId = (data["surfaceId"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return
        val componentsArray = data["components"]?.jsonArray ?: return

        val state = surfaces.getOrPut(surfaceId) { SurfaceState(surfaceId) }

        for (compElement in componentsArray) {
            val compObj = compElement.jsonObject
            val componentDef = ComponentDef.fromJson(compObj)

            // Convert ComponentDef (v0.9) to Component for rendering
            val component = Component.fromComponentDef(componentDef)
            state.components[component.id] = component
        }
    }

    private fun handleDataModelUpdate(data: JsonObject) {
        val surfaceId = (data["surfaceId"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return
        val path = (data["path"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return
        val contentsArray = data["contents"]?.jsonArray ?: return

        println("Debug: (SurfaceStateManager) handleDataModelUpdate surfaceId=$surfaceId path=$path contents=${contentsArray.size} items")

        val state = surfaces.getOrPut(surfaceId) { SurfaceState(surfaceId) }

        for (entryElement in contentsArray) {
            val entryObj = entryElement.jsonObject
            println("Debug: (SurfaceStateManager) Parsing entry: $entryObj")
            try {
                val entry = json.decodeFromJsonElement(DataEntry.serializer(), entryObj)
                val fullPath = if (path.endsWith("/")) "$path${entry.key}" else "$path/${entry.key}"
                val jsonValue = entry.toJsonElement()
                println("Debug: (SurfaceStateManager) Setting $fullPath = $jsonValue")
                state.dataModel.update(fullPath, jsonValue)
            } catch (e: Exception) {
                println("Debug: (SurfaceStateManager) Error parsing entry: ${e.message}")
                e.printStackTrace()
            }
        }

        // Debug: print current data model state
        println("Debug: (SurfaceStateManager) Data model after update: ${state.dataModel.currentData}")
    }

    private fun handleDeleteSurface(data: JsonObject) {
        val surfaceId = (data["surfaceId"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: return
        surfaces.remove(surfaceId)
    }

    /**
     * Returns a map of all active surfaces.
     */
    fun getSurfaces(): Map<String, UiDefinition> {
        return surfaces.mapValues { it.value.toUiDefinition() }
    }

    /**
     * Returns the data model for a specific surface.
     */
    fun getDataModel(surfaceId: String): DataModel? {
        return surfaces[surfaceId]?.dataModel
    }

    /**
     * Returns a specific surface definition.
     */
    fun getSurface(surfaceId: String): UiDefinition? {
        return surfaces[surfaceId]?.toUiDefinition()
    }

    /**
     * Clears all surfaces.
     */
    fun clear() {
        surfaces.clear()
    }

    /**
     * Returns the number of active surfaces.
     */
    val surfaceCount: Int
        get() = surfaces.size
}
