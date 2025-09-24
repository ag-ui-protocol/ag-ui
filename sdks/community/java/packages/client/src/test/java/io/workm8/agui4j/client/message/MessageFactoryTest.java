package io.workm8.agui4j.client.message;

import io.workm8.agui4j.core.exception.AGUIException;
import io.workm8.agui4j.core.function.FunctionCall;
import io.workm8.agui4j.core.message.*;
import io.workm8.agui4j.core.tool.ToolCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

@DisplayName("MessageFactory")
class MessageFactoryTest {

    private final MessageFactory sut = new MessageFactory();

    @Test
    void shouldCreateUserMessage() throws AGUIException {
        var id = UUID.randomUUID().toString();

        sut.createMessage(id, Role.User);

        var message = sut.getMessage(id);

        assertThat(message).isInstanceOf(UserMessage.class);
        assertThat(message.getId()).isEqualTo(id);
        assertThat(message.getRole()).isEqualTo(Role.User);
        assertThat(message.getName()).isEqualTo("User");
    }

    @Test
    void shouldCreateSystemMessage() throws AGUIException {
        var id = UUID.randomUUID().toString();

        sut.createMessage(id, Role.System);

        var message = sut.getMessage(id);

        assertThat(message).isInstanceOf(SystemMessage.class);
        assertThat(message.getId()).isEqualTo(id);
        assertThat(message.getRole()).isEqualTo(Role.System);
        assertThat(message.getName()).isEqualTo("System");
    }

    @Test
    void shouldCreateAssistantMessage() throws AGUIException {
        var id = UUID.randomUUID().toString();

        sut.createMessage(id, Role.Assistant);

        var message = sut.getMessage(id);

        assertThat(message).isInstanceOf(AssistantMessage.class);
        assertThat(message.getId()).isEqualTo(id);
        assertThat(message.getRole()).isEqualTo(Role.Assistant);
        assertThat(message.getName()).isEqualTo("Assistant");
    }

    @Test
    void shouldCreateDeveloperMessage() throws AGUIException {
        var id = UUID.randomUUID().toString();

        sut.createMessage(id, Role.Developer);

        var message = sut.getMessage(id);

        assertThat(message).isInstanceOf(DeveloperMessage.class);
        assertThat(message.getId()).isEqualTo(id);
        assertThat(message.getRole()).isEqualTo(Role.Developer);
        assertThat(message.getName()).isEqualTo("Developer");
    }

    @Test
    void shouldCreateToolMessage() throws AGUIException {
        var id = UUID.randomUUID().toString();

        sut.createMessage(id, Role.Tool);

        var message = sut.getMessage(id);

        assertThat(message).isInstanceOf(ToolMessage.class);
        assertThat(message.getId()).isEqualTo(id);
        assertThat(message.getRole()).isEqualTo(Role.Tool);
        assertThat(message.getName()).isEqualTo("Tool");
    }

    @Test
    void shouldThrowAGUIExceptionOnUnknownId() {
        assertThatExceptionOfType(AGUIException.class)
            .isThrownBy(() -> sut.getMessage("fail"))
            .withMessage("No message with id 'fail' found. Create a new message first with the 'MESSAGE_STARTED' event.");
    }

    @Test
    void shouldAddChunk() throws AGUIException {
        var id = UUID.randomUUID().toString();

        sut.createMessage(id, Role.User);

        sut.addChunk(id, "Hi");

        var message = sut.getMessage(id);

        assertThat(message.getContent()).isEqualTo("Hi");
    }

    @Test
    void shouldAddMultipleChunks() throws AGUIException {
        var id = UUID.randomUUID().toString();

        sut.createMessage(id, Role.User);

        sut.addChunk(id, "Hi,");
        sut.addChunk(id, " how are you?");
        var message = sut.getMessage(id);

        assertThat(message.getContent()).isEqualTo("Hi, how are you?");
    }

    @Test
    void shouldRemoveMessage() throws AGUIException {
        var id = UUID.randomUUID().toString();
        sut.createMessage(id, Role.User);

        sut.getMessage(id);

        sut.removeMessage(id);

        assertThatExceptionOfType(AGUIException.class)
            .isThrownBy(() -> sut.getMessage(id))
            .withMessage("No message with id '%s' found. Create a new message first with the 'MESSAGE_STARTED' event.".formatted(id));
    }

    @Test
    void shouldAddToolCall() throws AGUIException {
        var id = UUID.randomUUID().toString();
        sut.createMessage(id, Role.Assistant);

        var toolCall = new ToolCall(UUID.randomUUID().toString(), "tool", new FunctionCall("function", "params"));

        sut.addToolCall(id, toolCall);

        var message = sut.getMessage(id);

        assertThat(((AssistantMessage)message).getToolCalls()).containsExactly(toolCall);
    }

    @Test
    void shouldThrowAGUIExceptionWhenAddingToolCallToOtherMessageType() throws AGUIException {
        var id = UUID.randomUUID().toString();
        sut.createMessage(id, Role.User);

        var toolCall = new ToolCall(UUID.randomUUID().toString(), "tool", new FunctionCall("function", "params"));

        assertThatExceptionOfType(AGUIException.class)
            .isThrownBy(() -> sut.addToolCall(id, toolCall))
            .withMessage("Cannot add tool call for message with role 'User'.");
    }

    @Test
    void shouldSetError() throws AGUIException {
        var id = UUID.randomUUID().toString();
        sut.createMessage(id, Role.Tool);

        var error = "Error";

        sut.setError(id, error);

        var message = sut.getMessage(id);

        assertThat(((ToolMessage)message).getError()).isEqualTo(error);
    }

    @Test
    void shouldThrowAGUIExceptionOnSettingErrorToOtherMessageType() throws AGUIException {
        var id = UUID.randomUUID().toString();
        sut.createMessage(id, Role.User);

        assertThatExceptionOfType(AGUIException.class)
            .isThrownBy(() -> sut.setError(id, "error"))
            .withMessage("Cannot set an error for message with role 'User'.");
    }

    @Test
    void shouldSetToolCallId() throws AGUIException {
        var id = UUID.randomUUID().toString();
        sut.createMessage(id, Role.Tool);

        var toolCallId = UUID.randomUUID().toString();

        sut.setToolCallId(id, toolCallId);

        var message = sut.getMessage(id);

        assertThat(((ToolMessage)message).getToolCallId()).isEqualTo(toolCallId);
    }

    @Test
    void shouldThrowAGUIExceptionOnSettingToolCallIdToMessageWithOtherRole() throws AGUIException {
        var id = UUID.randomUUID().toString();
        sut.createMessage(id, Role.User);

        assertThatExceptionOfType(AGUIException.class)
            .isThrownBy(() -> sut.setToolCallId(id, "error"))
            .withMessage("Cannot set tool call id for message with role 'User'.");
    }

}