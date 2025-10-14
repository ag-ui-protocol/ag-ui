package com.agui.json.mixins;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;

import java.util.Map;

/**
 * Jackson mixin interface for configuring JSON serialization of State objects.
 * <p>
 * StateMixin provides Jackson annotations to enable flexible JSON serialization and
 * deserialization of State objects using dynamic property handling. Unlike the other
 * mixins which handle polymorphic types, this mixin focuses on enabling State objects
 * to be serialized as flat JSON objects with arbitrary key-value pairs.
 * <p>
 * The mixin configures Jackson to:
 * <ul>
 * <li>Serialize the entire state map as top-level JSON properties using {@link JsonAnyGetter}</li>
 * <li>Deserialize any JSON properties directly into the state map using {@link JsonAnySetter}</li>
 * <li>Handle dynamic state properties without requiring predefined fields</li>
 * <li>Support arbitrary key-value pairs for flexible state management</li>
 * </ul>
 * <p>
 * Key features:
 * <ul>
 * <li><strong>Flat serialization</strong>: State properties appear as top-level JSON fields</li>
 * <li><strong>Dynamic properties</strong>: No need to predefine state structure</li>
 * <li><strong>Type preservation</strong>: Object values maintain their types during serialization</li>
 * <li><strong>Bidirectional mapping</strong>: Seamless serialization and deserialization</li>
 * </ul>
 * <p>
 * This approach enables State objects to function as flexible containers for agent
 * context, configuration, and runtime data without requiring rigid schemas. It's
 * particularly useful for:
 * <ul>
 * <li>Agent memory and context persistence</li>
 * <li>Dynamic configuration management</li>
 * <li>Inter-agent state sharing</li>
 * <li>Workflow state preservation</li>
 * </ul>
 * <p>
 * Example JSON representation:
 * <pre>{@code
 * // State object with various properties
 * {
 *   "currentUser": "john.doe",
 *   "sessionId": "sess-123",
 *   "preferences": {
 *     "theme": "dark",
 *     "language": "en"
 *   },
 *   "counters": {
 *     "interactions": 15,
 *     "errors": 0
 *   }
 * }
 * }</pre>
 * <p>
 * The mixin eliminates the need for wrapper objects or nested structures,
 * providing a clean, flat JSON representation that's easy to work with
 * in both client and server environments.
 *
 * @author Pascal Wilbrink
 */
public interface StateMixin {

    /**
     * Gets the entire state as a map for JSON serialization.
     * <p>
     * This method is annotated with {@link JsonAnyGetter} to instruct Jackson
     * to serialize all map entries as top-level properties in the JSON output.
     * This creates a flat JSON structure where each state key becomes a
     * direct property of the JSON object.
     * <p>
     * The method should return the internal state map containing all
     * key-value pairs that represent the current state of the object.
     *
     * @return a map containing all state key-value pairs to be serialized
     *         as top-level JSON properties
     */
    @JsonAnyGetter
    Map<String, Object> getState();

    /**
     * Sets a single key-value pair in the state during JSON deserialization.
     * <p>
     * This method is annotated with {@link JsonAnySetter} to instruct Jackson
     * to call this method for each JSON property that doesn't map to a
     * specific field. This enables dynamic deserialization where any JSON
     * property is automatically added to the state map.
     * <p>
     * The method should store the key-value pair in the internal state map,
     * allowing for flexible state reconstruction from JSON without requiring
     * predefined property structures.
     *
     * @param key   the property name from the JSON object
     * @param value the property value from the JSON object, which can be
     *              any JSON-compatible type (String, Number, Boolean,
     *              Map, List, or null)
     */
    @JsonAnySetter
    void set(String key, Object value);

}