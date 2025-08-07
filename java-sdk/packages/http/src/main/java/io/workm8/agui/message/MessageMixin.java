package io.workm8.agui.message;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import io.workm8.agui.message.*;

@JsonTypeInfo(
    use = JsonTypeInfo.Id.NAME,
    property = "role"
)
@JsonSubTypes({
    @JsonSubTypes.Type(value = AssistantMessage.class, name = "assistant"),
    @JsonSubTypes.Type(value = DeveloperMessage.class, name = "developer"),
    @JsonSubTypes.Type(value = UserMessage.class, name = "user"),
    @JsonSubTypes.Type(value = SystemMessage.class, name = "system"),
    @JsonSubTypes.Type(value = ToolMessage.class, name = "tool")
})
public interface MessageMixin {
}
