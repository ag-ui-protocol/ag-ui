package io.workm8.agui4j.json;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.workm8.agui4j.core.event.BaseEvent;
import io.workm8.agui4j.core.message.BaseMessage;
import io.workm8.agui4j.core.state.State;
import io.workm8.agui4j.json.mixins.EventMixin;
import io.workm8.agui4j.json.mixins.MessageMixin;
import io.workm8.agui4j.json.mixins.StateMixin;

import java.util.Objects;

/**
 * Factory class for configuring Jackson ObjectMapper instances with agui4j-specific mixins.
 * <p>
 * ObjectMapperFactory provides utility methods for enhancing Jackson ObjectMapper instances
 * with the necessary mixin configurations to properly serialize and deserialize agui4j
 * core objects. This ensures consistent JSON handling across the framework for messages,
 * events, and state objects.
 * <p>
 * The factory configures mixins for:
 * <ul>
 * <li>BaseMessage and its subclasses - for proper message serialization</li>
 * <li>BaseEvent and its subclasses - for consistent event JSON representation</li>
 * <li>State objects - for state persistence and transmission</li>
 * </ul>
 * <p>
 * Mixins provide a non-intrusive way to add Jackson annotations to classes without
 * modifying the original class definitions. This approach maintains clean separation
 * between the core domain objects and their JSON serialization concerns.
 * <p>
 * This class is designed as a utility class with static methods and should not be
 * instantiated. It provides a centralized configuration point for JSON serialization
 * across the agui4j framework.
 * <p>
 * Example usage:
 * <pre>{@code
 * ObjectMapper mapper = new ObjectMapper();
 * ObjectMapperFactory.addMixins(mapper);
 *
 * // Now the mapper can properly serialize agui4j objects
 * String json = mapper.writeValueAsString(baseMessage);
 * BaseMessage message = mapper.readValue(json, BaseMessage.class);
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
public class ObjectMapperFactory {

    /**
     * Private constructor
     */
    private ObjectMapperFactory() { }

    /**
     * Adds agui4j-specific mixins to the provided ObjectMapper instance.
     * <p>
     * This method configures the ObjectMapper with the necessary mixin classes
     * to handle serialization and deserialization of agui4j core objects. The
     * mixins provide JSON annotations and custom serialization logic without
     * polluting the core domain classes with Jackson-specific code.
     * <p>
     * The configured mixins include:
     * <ul>
     * <li>{@link MessageMixin} - for BaseMessage and all message subclasses</li>
     * <li>{@link EventMixin} - for BaseEvent and all event subclasses</li>
     * <li>{@link StateMixin} - for State objects and state management</li>
     * </ul>
     * <p>
     * After calling this method, the ObjectMapper will be able to:
     * <ul>
     * <li>Serialize agui4j objects to JSON with proper formatting</li>
     * <li>Deserialize JSON back to the correct agui4j object types</li>
     * <li>Handle polymorphic types and inheritance hierarchies correctly</li>
     * <li>Maintain type information for proper object reconstruction</li>
     * </ul>
     * <p>
     * This method is idempotent - calling it multiple times on the same
     * ObjectMapper instance will not cause issues, though it's generally
     * recommended to configure the mapper once during initialization.
     *
     * @param objectMapper the Jackson ObjectMapper instance to configure
     *                    with agui4j mixins
     * @throws IllegalArgumentException if objectMapper is null
     */
    public static void addMixins(final ObjectMapper objectMapper) {
        if (Objects.isNull(objectMapper.findMixInClassFor(BaseMessage.class))) {
            objectMapper.addMixIn(BaseMessage.class, MessageMixin.class);
        }
        if (Objects.isNull(objectMapper.findMixInClassFor(BaseEvent.class))) {
            objectMapper.addMixIn(BaseEvent.class, EventMixin.class);
        }
        if (Objects.isNull(objectMapper.findMixInClassFor(State.class))) {
            objectMapper.addMixIn(State.class, StateMixin.class);
        }
    }

}