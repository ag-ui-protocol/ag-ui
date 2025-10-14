package com.agui.core.exception;

/**
 * A custom exception class for AGUI-specific errors and exceptional conditions.
 * <p>
 * This exception serves as the base exception type for all AGUI-related errors
 * that occur within the application. It extends the standard {@link Exception}
 * class and provides constructors for both simple error messages and chained
 * exceptions to preserve the original cause of errors.
 * </p>
 * <p>
 * This is a checked exception, meaning it must be explicitly handled or declared
 * in method signatures where it might be thrown.
 * </p>
 *
 * @see Exception
 *
 * @author Pascal Wilbrink
 */
public class AGUIException extends Exception {

    /**
     * Creates a new AGUIException with the specified error message.
     * <p>
     * The cause is not initialized and may subsequently be initialized by
     * a call to {@link #initCause(Throwable)}.
     * </p>
     *
     * @param message the detail message explaining the reason for the exception
     */
    public AGUIException(final String message) {
        this(message, null);
    }

    /**
     * Creates a new AGUIException with the specified error message and cause.
     * <p>
     * This constructor is useful for wrapping lower-level exceptions while
     * providing additional context through the message parameter.
     * </p>
     *
     * @param message the detail message explaining the reason for the exception
     * @param cause   the underlying cause of this exception, or null if the
     *                cause is nonexistent or unknown
     */
    public AGUIException(final String message, final Throwable cause) {
        super(message, cause);
    }
}