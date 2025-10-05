package com.agui.core.function;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

@DisplayName("FunctionCall")
class FunctionCallTest {

    @Test
    void shouldThrowErrorOnNullName() {
        assertThatExceptionOfType(RuntimeException.class)
            .isThrownBy(() -> new FunctionCall(null, "args"))
            .withMessage("name cannot be null");
    }

    @Test
    void shouldCreateFunctionCall() {
        var functionCall = new FunctionCall("name", "args");
        assertThat(functionCall.name()).isEqualTo("name");
        assertThat(functionCall.arguments()).isEqualTo("args");
    }
}