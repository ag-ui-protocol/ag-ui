package com.agui.a2ui.data

import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import com.agui.a2ui.model.DataContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/**
 * Centralized reactive data store for A2UI surfaces.
 *
 * The DataModel holds all dynamic data for a surface and provides
 * reactive subscriptions for Compose to observe changes.
 * Data is accessed using JSON Pointer paths (e.g., "/user/name").
 */
class DataModel(
    initialData: JsonObject = JsonObject(emptyMap())
) {
    private val _data = MutableStateFlow(initialData)

    /**
     * Observable state of the entire data model.
     */
    val data: StateFlow<JsonObject> = _data.asStateFlow()

    /**
     * Gets the current snapshot of the data.
     */
    val currentData: JsonObject
        get() = _data.value

    /**
     * Replaces the entire data model (snapshot update).
     */
    fun setData(newData: JsonObject) {
        _data.value = newData
    }

    /**
     * Updates a value at the specified path.
     *
     * @param path JSON Pointer path (e.g., "/user/name")
     * @param value The new value to set
     */
    fun update(path: String, value: JsonElement) {
        val segments = parsePath(path)
        if (segments.isEmpty()) {
            if (value is JsonObject) {
                _data.value = value
            }
            return
        }

        _data.value = setAtPath(_data.value, segments, value)
    }

    /**
     * Updates a string value at the specified path.
     */
    fun updateString(path: String, value: String) {
        update(path, JsonPrimitive(value))
    }

    /**
     * Updates a number value at the specified path.
     */
    fun updateNumber(path: String, value: Double) {
        update(path, JsonPrimitive(value))
    }

    /**
     * Updates a boolean value at the specified path.
     */
    fun updateBoolean(path: String, value: Boolean) {
        update(path, JsonPrimitive(value))
    }

    /**
     * Gets a value at the specified path.
     */
    fun get(path: String): JsonElement? {
        val segments = parsePath(path)
        return getAtPath(_data.value, segments)
    }

    /**
     * Gets a string value at the specified path.
     */
    fun getString(path: String): String? {
        return get(path)?.jsonPrimitive?.contentOrNull
    }

    /**
     * Gets a number value at the specified path.
     */
    fun getNumber(path: String): Double? {
        return get(path)?.jsonPrimitive?.doubleOrNull
    }

    /**
     * Gets a boolean value at the specified path.
     */
    fun getBoolean(path: String): Boolean? {
        return get(path)?.jsonPrimitive?.booleanOrNull
    }

    /**
     * Gets a list of strings at the specified path.
     */
    fun getStringList(path: String): List<String>? {
        return try {
            get(path)?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Gets the size of an array at the specified path.
     */
    fun getArraySize(path: String): Int? {
        return try {
            (get(path) as? JsonArray)?.size
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Gets the keys of an object at the specified path.
     */
    fun getObjectKeys(path: String): List<String>? {
        return try {
            (get(path) as? JsonObject)?.keys?.toList()
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Creates a StateFlow for observing a specific path.
     */
    fun observePath(path: String): StateFlow<JsonElement?> {
        val segments = parsePath(path)
        return MutableStateFlow(getAtPath(_data.value, segments)).also { flow ->
            // Note: In a real implementation, we'd set up proper observation
            // For now, consumers should use observeData and map
        }
    }

    /**
     * Creates a DataContext for accessing this model.
     */
    fun createContext(basePath: String = ""): DataContext {
        return DataModelContext(this, basePath)
    }

    // Internal path parsing and traversal

    private fun parsePath(path: String): List<String> {
        if (path.isEmpty() || path == "/") return emptyList()
        return path.trimStart('/').split('/').filter { it.isNotEmpty() }
    }

    private fun getAtPath(obj: JsonElement, segments: List<String>): JsonElement? {
        if (segments.isEmpty()) return obj

        val current = when (obj) {
            is JsonObject -> obj[segments.first()]
            is JsonArray -> segments.first().toIntOrNull()?.let { index ->
                obj.getOrNull(index)
            }
            else -> null
        } ?: return null

        return getAtPath(current, segments.drop(1))
    }

    private fun setAtPath(obj: JsonObject, segments: List<String>, value: JsonElement): JsonObject {
        if (segments.isEmpty()) return obj

        val key = segments.first()
        val remaining = segments.drop(1)

        return if (remaining.isEmpty()) {
            JsonObject(obj.toMutableMap().apply { put(key, value) })
        } else {
            val existing = obj[key]
            val child = when (existing) {
                is JsonObject -> setAtPath(existing, remaining, value)
                else -> setAtPath(JsonObject(emptyMap()), remaining, value)
            }
            JsonObject(obj.toMutableMap().apply { put(key, child) })
        }
    }
}

/**
 * DataContext implementation backed by a DataModel.
 */
internal class DataModelContext(
    private val model: DataModel,
    private val basePath: String = ""
) : DataContext {

    private fun resolvePath(path: String): String {
        return if (basePath.isEmpty()) path
        else if (path.startsWith("/")) "$basePath$path"
        else "$basePath/$path"
    }

    override fun getString(path: String): String? = model.getString(resolvePath(path))

    override fun getNumber(path: String): Double? = model.getNumber(resolvePath(path))

    override fun getBoolean(path: String): Boolean? = model.getBoolean(resolvePath(path))

    override fun getStringList(path: String): List<String>? = model.getStringList(resolvePath(path))

    override fun getArraySize(path: String): Int? = model.getArraySize(resolvePath(path))

    override fun getObjectKeys(path: String): List<String>? = model.getObjectKeys(resolvePath(path))

    override fun update(path: String, value: Any?) {
        val resolvedPath = resolvePath(path)
        when (value) {
            is String -> model.updateString(resolvedPath, value)
            is Number -> model.updateNumber(resolvedPath, value.toDouble())
            is Boolean -> model.updateBoolean(resolvedPath, value)
            null -> model.update(resolvedPath, JsonNull)
            else -> model.updateString(resolvedPath, value.toString())
        }
    }

    override fun withBasePath(basePath: String): DataContext {
        val newBase = if (this.basePath.isEmpty()) basePath
        else "${this.basePath}$basePath"
        return DataModelContext(model, newBase)
    }
}

/**
 * Creates and remembers a DataModel instance.
 */
@Composable
fun rememberDataModel(initialData: JsonObject = JsonObject(emptyMap())): DataModel {
    return remember { DataModel(initialData) }
}

/**
 * Observes the data model and returns a State that updates when data changes.
 */
@Composable
fun DataModel.collectAsState(): State<JsonObject> {
    return data.collectAsState()
}
