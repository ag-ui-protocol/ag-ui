package io.workm8.agui.state;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;

import java.util.Map;

public interface StateMixin {

    @JsonAnyGetter
    Map<String, Object> getState();

    @JsonAnySetter
    void set(String key, Object value);
}