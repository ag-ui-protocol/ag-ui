package io.workm8.agui.client.message;

import io.workm8.agui.exception.AGUIException;
import io.workm8.agui.message.*;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class MessageFactory {

    private final Map<String, MessagePart> messages;

    public MessageFactory() {
        this.messages = new HashMap<>();
    }

    public void createMessage(final String id, final String role) {
        this.messages.put(id, new MessagePart(role, new ArrayList<>()));
    }

    public void addChunk(final String id, final String chunk) throws AGUIException {
        if (!this.messages.containsKey(id)) {
            throw new AGUIException("No message with id '%s' found. Create a new message first with the 'MESSAGE_STARTED' event.".formatted(id));
        }
        messages.get(id).chunks().add(chunk);
    }

    public BaseMessage getMessage(final String id) throws AGUIException {
        if (!this.messages.containsKey(id)) {
            throw new AGUIException("No message with id '%s' found. Create a new message first with the 'MESSAGE_STARTED' event.".formatted(id));
        }

        var messagePart = this.messages.get(id);

        switch (messagePart.role()) {
            case "developer":
                var developerMessage = new DeveloperMessage();
                developerMessage.setId(id);
                developerMessage.setContent(String.join("", messagePart.chunks()));
                developerMessage.setName("Developer");
                return developerMessage;
            case "assistant":
                var assistantMessage = new AssistantMessage();
                assistantMessage.setId(id);
                assistantMessage.setContent(String.join("", messagePart.chunks()));
                assistantMessage.setName("assistant");
                return assistantMessage;
            case "user":
                var userMessage = new UserMessage();
                userMessage.setId(id);
                userMessage.setContent(String.join("", messagePart.chunks()));
                userMessage.setName("user");
                return userMessage;
            case "tool":
                var toolMessage = new ToolMessage();
                toolMessage.setId(id);
                toolMessage.setContent(String.join("", messagePart.chunks()));
                toolMessage.setName("tool");
                return toolMessage;
            default:
                throw new AGUIException("Message type %s is not supported".formatted(messagePart.role()));
        }

    }

    record MessagePart(String role, List<String> chunks) { }

}

