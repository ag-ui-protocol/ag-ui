package io.workm8.agui.message;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("DeveloperMessage")
public class DeveloperMessageTest {

    @Test
    public void itShouldMapProperties() {
        var message = new DeveloperMessage();

        assertThat(message.getRole()).isEqualTo("developer");
        assertThat(message.getContent()).isEqualTo("");
        assertThat(message.getId()).isNotNull();
        assertThat(message.getName()).isEqualTo("");
    }

}
