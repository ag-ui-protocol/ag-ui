package com.agui.core.message;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("UserMessage")
class UserMessageTest {

    @Test
    void shouldSetRole() {
        var message = new UserMessage();

        assertThat(message.getRole()).isEqualTo(Role.user);
    }
}