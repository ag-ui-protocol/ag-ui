package com.agui.core.type;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("EventType")
class EventTypeTest {

    @Test
    void shouldHaveConsistentNaming() {
        for (EventType eventType : EventType.values()) {
            assertThat(eventType.getName()).isEqualTo(eventType.name());
        }
    }
}