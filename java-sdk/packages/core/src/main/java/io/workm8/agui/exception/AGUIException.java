package io.workm8.agui.exception;

public class AGUIException extends Exception {

    public AGUIException(final String message) {
        this(message, null);
    }

    public AGUIException(final String message, final Throwable cause) {
        super(message, cause);
    }
}
