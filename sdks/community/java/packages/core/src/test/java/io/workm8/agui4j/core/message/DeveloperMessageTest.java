package io.workm8.agui4j.core.message;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("DeveloperMessage")
class DeveloperMessageTest {

    @Test
    void shouldSetRole() {
        var message = new DeveloperMessage();

        assertThat(message.getRole()).isEqualTo(Role.Developer);
    }
}