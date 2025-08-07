package io.workm8.agui.message;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("UserMessage")
public class UserMessageTest {

    @Test
    public void itShouldMapProperties() {
        var message = new UserMessage();

        assertThat(message.getRole()).isEqualTo("user");
        assertThat(message.getContent()).isEqualTo("");
        assertThat(message.getId()).isNotNull();
        assertThat(message.getName()).isEqualTo("");
    }

}
