package com.agui.core.state;

import java.util.HashMap;
import java.util.Map;

/**
 * A state container for storing and managing key-value pairs.
 * <p>
 * This class provides a simple state management mechanism using a map-based
 * storage system. It allows storing arbitrary objects associated with string
 * keys, making it useful for maintaining application state, configuration
 * data, or temporary data storage throughout the application lifecycle.
 * </p>
 * <p>
 * The state is mutable and thread-unsafe. If thread safety is required,
 * external synchronization should be used or consider using concurrent
 * map implementations.
 * </p>
 *
 * @author Pascal Wilbrink
 */
public class State {

    private final Map<String, Object> stateMap;

    /**
     * Creates a new empty State instance.
     * <p>
     * Initializes the internal state map as an empty HashMap.
     * </p>
     */
    public State() {
        this(new HashMap<>());
    }

    public State(final Map<String, Object> stateMap) {
        this.stateMap = stateMap;
    }

    /**
     * Sets a value for the specified key in the state.
     * <p>
     * If the key already exists, its value will be replaced with the new value.
     * Both key and value can be null, though null keys may cause issues in
     * some contexts.
     * </p>
     *
     * @param key   the key to associate with the value
     * @param value the value to store, can be null
     */
    public void set(final String key, final Object value) {
        this.stateMap.put(key, value);
    }

    /**
     * Returns the entire state map.
     * <p>
     * This method returns a direct reference to the internal map, allowing
     * external code to modify the state directly. Use with caution as this
     * breaks encapsulation.
     * </p>
     *
     * @return the internal state map containing all key-value pairs
     */
    public Map<String, Object> getState() {
        return this.stateMap;
    }

    /**
     * Retrieves the value associated with the specified key.
     * <p>
     * Returns null if the key is not found or if the stored value is null.
     * </p>
     *
     * @param key the key whose associated value is to be returned
     * @return the value associated with the key, or null if not found
     */
    public Object get(final String key) {
        return this.stateMap.get(key);
    }

    public String toString() {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, Object> entry : stateMap.entrySet()) {
            if (!sb.isEmpty()) {
                sb.append("\n");
            }
            sb.append(entry.getKey()).append(": ").append(entry.getValue());
        }
        return sb.toString();
    }

}