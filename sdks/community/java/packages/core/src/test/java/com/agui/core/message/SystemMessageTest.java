package com.agui.core.message;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("SystemMessage")
class SystemMessageTest {

    @Test
    void shouldSetRole() {
        var message = new SystemMessage();

        assertThat(message.getRole()).isEqualTo(Role.system);
    }
}