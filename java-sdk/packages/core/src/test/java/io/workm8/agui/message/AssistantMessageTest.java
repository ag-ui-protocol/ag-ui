package io.workm8.agui.message;

import io.workm8.agui.function.FunctionCall;
import io.workm8.agui.tool.ToolCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static java.util.Arrays.asList;
import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("AssistantMessage")
public class AssistantMessageTest {

    @Test
    public void itShouldMapProperties() {
        var message = new AssistantMessage();

        var toolCall1 = new ToolCall("1", "Tool", new FunctionCall("function-name", "params"));
        var toolCall2 = new ToolCall("2", "Second tool", new FunctionCall("function-2", "params"));

        message.setToolCalls(
            List.of(toolCall1, toolCall2)
        );

        assertThat(message.getRole()).isEqualTo("assistant");
        assertThat(message.getContent()).isEqualTo("");
        assertThat(message.getId()).isNotNull();
        assertThat(message.getName()).isEqualTo("");
        assertThat(message.getToolCalls()).containsExactlyInAnyOrderElementsOf(asList(toolCall1, toolCall2));
    }

}
