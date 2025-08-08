package io.workm8;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import io.workm8.agui.event.BaseEvent;
import io.workm8.agui.event.EventMixin;
import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.message.MessageMixin;
import io.workm8.agui.state.State;
import io.workm8.agui.state.StateMixin;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;

@Configuration
public class JacksonConfig {

    @Bean
    @Primary
    public ObjectMapper objectMapper() {
        ObjectMapper mapper = new ObjectMapper();
        mapper.disable(SerializationFeature.FAIL_ON_EMPTY_BEANS);

        // Bind mixins
        mapper.addMixIn(BaseMessage.class, MessageMixin.class);
        mapper.addMixIn(BaseEvent.class, EventMixin.class);
        mapper.addMixIn(State.class, StateMixin.class);

        return mapper;
    }
}
