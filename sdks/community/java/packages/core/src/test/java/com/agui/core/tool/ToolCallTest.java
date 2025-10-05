package com.agui.core.tool;

import com.agui.core.function.FunctionCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

@DisplayName("ToolCall")
class ToolCallTest {

    @Test
    void shouldThrowNullPointerExceptionOnNullId() {
        assertThatExceptionOfType(NullPointerException.class)
            .isThrownBy(() -> new ToolCall(null, "type", null))
            .withMessage("id cannot be null");
    }

    @Test
    void shouldThrowNullPointerExceptionOnNullType() {
        assertThatExceptionOfType(NullPointerException.class)
            .isThrownBy(() -> new ToolCall("id", null, null))
            .withMessage("type cannot be null");
    }

    @Test
    void shouldCreateToolCall() {
        var id = UUID.randomUUID().toString();
        var type = "tool";
        var name = "function";
        var arguments = "{}";

        var function = new FunctionCall(name, arguments);
        var toolCall = new ToolCall(id, type, function);

        assertThat(toolCall.id()).isEqualTo(id);
        assertThat(toolCall.type()).isEqualTo(type);
        assertThat(toolCall.function()).isEqualTo(function);
    }
}