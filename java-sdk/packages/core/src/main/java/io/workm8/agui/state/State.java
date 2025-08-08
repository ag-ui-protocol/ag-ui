package io.workm8.agui.state;

import java.util.HashMap;
import java.util.Map;

public class State {

    private final Map<String, Object> stateMap;

    public State() {
        this.stateMap = new HashMap<>();
    }

    public void set(final String key, final Object value) {
        this.stateMap.put(key, value);
    }

    public Map<String, Object> getState() {
        return this.stateMap;
    }

    public Object get(final String key) {
        return this.stateMap.get(key);
    }
}
