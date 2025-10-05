package com.agui.core.tool;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

@DisplayName("Tool")
class ToolTest {

    @Test
    void shouldThrowNullPointerExceptionOnNullName() {
        assertThatExceptionOfType(NullPointerException.class)
            .isThrownBy(() -> new Tool(null, "description", null))
            .withMessage("name cannot be null");
    }

    @Test
    void shouldCreateToolWithParameters() {
        var name = "sayHello";
        var description = "Say hello to the user";
        var parameters = new Tool.ToolParameters("object", Map.of(
                "name",
                new Tool.ToolProperty("string", "the name of the user")
        ), List.of("name"));

        var tool = new Tool(name, description, parameters);

        assertThat(tool.name()).isEqualTo(name);
        assertThat(tool.description()).isEqualTo(description);
        assertThat(tool.parameters()).isEqualTo(parameters);
    }
}