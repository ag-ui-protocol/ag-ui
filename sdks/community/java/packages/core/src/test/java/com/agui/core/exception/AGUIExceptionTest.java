package com.agui.core.exception;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

@DisplayName("AGUIException")
class AGUIExceptionTest {

    @Test
    void shouldThrowException() {
        var ex = new AGUIException("TEST");

        assertThatExceptionOfType(AGUIException.class)
            .isThrownBy(() -> {
                throw ex;
            }).withMessage("TEST");
    }
}