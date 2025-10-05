package com.agui.core.state;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;


@DisplayName("State")
class StateTest {

    @Test
    void shouldCreateEmptyState() {
        var state = new State();

        assertThat(state).isNotNull();
    }

    @Test
    void shouldCreateStateWithValue() {
        var state = new State();
        var key = "name";
        var value = "John Doe";

        state.set(key, value);

        assertThat(state.get(key)).isInstanceOf(String.class);
        assertThat(state.get(key)).isEqualTo(value);
        assertThat(state.getState().get(key)).isEqualTo(value);
    }


}