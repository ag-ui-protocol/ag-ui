package com.agui.json;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.core.event.BaseEvent;
import com.agui.core.message.BaseMessage;
import com.agui.core.state.State;
import com.agui.json.mixins.EventMixin;
import com.agui.json.mixins.MessageMixin;
import com.agui.json.mixins.StateMixin;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("ObjectMapperFactory")
class ObjectMapperFactoryTest {

    private ObjectMapper objectMapper;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
    }

    @Test
    void shouldAddMessageMixin() {
        assertThat(objectMapper.findMixInClassFor(BaseMessage.class)).isNull();
        
        ObjectMapperFactory.addMixins(objectMapper);
        
        assertThat(objectMapper.findMixInClassFor(BaseMessage.class)).isEqualTo(MessageMixin.class);
    }

    @Test
    void shouldAddEventMixin() {
        assertThat(objectMapper.findMixInClassFor(BaseEvent.class)).isNull();
        
        ObjectMapperFactory.addMixins(objectMapper);
        
        assertThat(objectMapper.findMixInClassFor(BaseEvent.class)).isEqualTo(EventMixin.class);
    }

    @Test
    void shouldAddStateMixin() {
        assertThat(objectMapper.findMixInClassFor(State.class)).isNull();
        
        ObjectMapperFactory.addMixins(objectMapper);
        
        assertThat(objectMapper.findMixInClassFor(State.class)).isEqualTo(StateMixin.class);
    }

    @Test
    void shouldNotAddMixinTwice() {
        // Add mixins first time
        ObjectMapperFactory.addMixins(objectMapper);
        
        assertThat(objectMapper.findMixInClassFor(BaseMessage.class)).isEqualTo(MessageMixin.class);
        assertThat(objectMapper.findMixInClassFor(BaseEvent.class)).isEqualTo(EventMixin.class);
        assertThat(objectMapper.findMixInClassFor(State.class)).isEqualTo(StateMixin.class);
        
        // Add mixins second time - should not cause issues
        ObjectMapperFactory.addMixins(objectMapper);
        
        assertThat(objectMapper.findMixInClassFor(BaseMessage.class)).isEqualTo(MessageMixin.class);
        assertThat(objectMapper.findMixInClassFor(BaseEvent.class)).isEqualTo(EventMixin.class);
        assertThat(objectMapper.findMixInClassFor(State.class)).isEqualTo(StateMixin.class);
    }

    @Test
    void shouldBeIdempotent() {
        // Call multiple times
        ObjectMapperFactory.addMixins(objectMapper);
        ObjectMapperFactory.addMixins(objectMapper);
        ObjectMapperFactory.addMixins(objectMapper);
        
        // Should still have the correct mixins
        assertThat(objectMapper.findMixInClassFor(BaseMessage.class)).isEqualTo(MessageMixin.class);
        assertThat(objectMapper.findMixInClassFor(BaseEvent.class)).isEqualTo(EventMixin.class);
        assertThat(objectMapper.findMixInClassFor(State.class)).isEqualTo(StateMixin.class);
    }

    @Test
    void shouldNotAddMixinIfAlreadyPresent() {
        // Manually add a different mixin for BaseMessage
        objectMapper.addMixIn(BaseMessage.class, Object.class);
        
        ObjectMapperFactory.addMixins(objectMapper);
        
        // Should not override the existing mixin
        assertThat(objectMapper.findMixInClassFor(BaseMessage.class)).isEqualTo(Object.class);
        
        // But should add mixins for other classes
        assertThat(objectMapper.findMixInClassFor(BaseEvent.class)).isEqualTo(EventMixin.class);
        assertThat(objectMapper.findMixInClassFor(State.class)).isEqualTo(StateMixin.class);
    }

    @Test
    void shouldHavePrivateConstructor() {
        // Verify the class cannot be instantiated
        assertThat(ObjectMapperFactory.class.getDeclaredConstructors()).hasSize(1);
        assertThat(ObjectMapperFactory.class.getDeclaredConstructors()[0].getModifiers() & 0x00000002).isEqualTo(2); // Private modifier
    }
}