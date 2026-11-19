package com.agui.community.spring.server.core.jackson;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Jackson mix-in that writes the {@code type} member of a
 * {@link com.agui.community.core.message.ToolCall} on the wire. The protocol
 * requires {@code "type": "function"} on every tool call; in the record,
 * {@code type()} is a plain method rather than a component, so Jackson would
 * otherwise not expose it as a property. Read-only: the member is written on
 * serialization and ignored on deserialization, where the record supplies it.
 */
public interface ToolCallMixin {

    @JsonProperty(value = "type", access = JsonProperty.Access.READ_ONLY)
    String type();
}
