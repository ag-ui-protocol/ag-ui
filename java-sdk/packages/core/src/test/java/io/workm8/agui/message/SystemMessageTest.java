package io.workm8.agui.message;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("SystemMessage")
public class SystemMessageTest {

    @Test
    public void itShouldMapProperties() {
        var message = new SystemMessage();

        assertThat(message.getRole()).isEqualTo("system");
        assertThat(message.getContent()).isEqualTo("");
        assertThat(message.getId()).isNotNull();
        assertThat(message.getName()).isEqualTo("");
    }

}
