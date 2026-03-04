package com.agui.spring.ai;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.ToolCallArgsEvent;
import com.agui.core.event.ToolCallEndEvent;
import com.agui.core.event.ToolCallStartEvent;
import com.agui.core.tool.Tool;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.definition.ToolDefinition;

import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * Utility class for converting agui tool definitions to Spring AI tool callbacks.
 * <p>
 * ToolMapper provides conversion functionality between agui's Tool format and Spring AI's
 * ToolCallback format, enabling seamless integration of function calling capabilities
 * between the two frameworks. The mapper handles tool metadata, parameter definitions,
 * JSON schema generation, and event-driven tool execution tracking.
 * <p>
 * The conversion process includes:
 * <ul>
 * <li>Tool name and description mapping</li>
 * <li>Parameter schema serialization to JSON format</li>
 * <li>Event generation for tool call lifecycle tracking</li>
 * <li>Integration with Spring AI's ToolCallback interface</li>
 * </ul>
 * <p>
 * Key features:
 * <ul>
 * <li>Real-time event emission during tool execution</li>
 * <li>Automatic JSON schema generation for tool parameters</li>
 * <li>Deferred event processing for proper event ordering</li>
 * <li>Error handling for JSON serialization issues</li>
 * </ul>
 * <p>
 * This class requires an ObjectMapper for JSON serialization and uses a consumer
 * pattern for event handling, allowing for flexible event processing strategies.
 *
 * @author Pascal Wilbrink
 */
public class ToolMapper {

    private final ObjectMapper objectMapper;

    /**
     * Constructs a ToolMapper with the specified ObjectMapper for JSON serialization.
     * <p>
     * The ObjectMapper is used to serialize tool parameters into JSON schema format
     * as required by Spring AI's tool definition system.
     *
     */
    public ToolMapper() {
        this.objectMapper = new ObjectMapper();
    }

    /**
     * Converts an agui Tool to a Spring AI ToolCallback with event tracking.
     * <p>
     * This method creates a Spring AI ToolCallback that wraps the agui tool definition
     * and provides event-driven execution tracking. The callback handles tool execution
     * and emits appropriate events through the provided consumer for monitoring and
     * user interface updates.
     * <p>
     * The conversion process:
     * <ul>
     * <li>Creates a ToolDefinition with name, description, and JSON schema</li>
     * <li>Implements tool execution with automatic event generation</li>
     * <li>Generates unique tool call IDs for tracking</li>
     * <li>Emits start, args, and end events during execution</li>
     * <li>Handles JSON serialization errors gracefully</li>
     * </ul>
     * <p>
     * Event emission sequence:
     * <ol>
     * <li>ToolCallStartEvent - when tool execution begins</li>
     * <li>ToolCallArgsEvent - containing tool input arguments</li>
     * <li>ToolCallEndEvent - when tool execution completes</li>
     * </ol>
     * <p>
     * The returned ToolCallback integrates seamlessly with Spring AI's function
     * calling mechanisms and provides real-time feedback through the event system.
     *
     * @param tool          the agui Tool to convert to Spring AI format
     * @param messageId     the parent message ID for event association
     * @param eventConsumer the consumer for receiving tool execution events
     * @return a Spring AI ToolCallback with embedded event tracking
     */
    public ToolCallback toSpringTool(final Tool tool, final String messageId, final Consumer<BaseEvent> eventConsumer) {
        return new ToolCallback() {
            @Override
            public ToolDefinition getToolDefinition() {
                return new ToolDefinition() {
                    @Override
                    public String name() {
                        return tool.name();
                    }

                    @Override
                    public String description() {
                        return tool.description();
                    }

                    @Override
                    public String inputSchema() {
                        try {
                            return objectMapper.writeValueAsString(tool.parameters());
                        } catch (JsonProcessingException e) {
                            return "";
                        }
                    }
                };
            }

            @Override
            public String call(String toolInput) {
                var toolCallId = UUID.randomUUID().toString();

                var toolCallStartEvent = new ToolCallStartEvent();
                toolCallStartEvent.setParentMessageId(messageId);
                toolCallStartEvent.setToolCallName(tool.name());
                toolCallStartEvent.setToolCallId(toolCallId);

                eventConsumer.accept(toolCallStartEvent);

                var toolCallArgsEvent = new ToolCallArgsEvent();
                toolCallArgsEvent.setDelta(toolInput);
                toolCallArgsEvent.setToolCallId(toolCallId);

                eventConsumer.accept(toolCallArgsEvent);

                var toolCallEndEvent = new ToolCallEndEvent();
                toolCallEndEvent.setToolCallId(toolCallId);

                eventConsumer.accept(toolCallEndEvent);

                return "";
            }
        };
    }
}
