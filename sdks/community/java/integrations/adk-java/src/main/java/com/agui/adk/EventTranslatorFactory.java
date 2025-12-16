package com.agui.adk;

/**
 * A factory for creating {@link EventTranslator} instances.
 * This allows for providing different implementations or mocks for testing.
 */
public interface EventTranslatorFactory {
    /**
     * Creates a new {@link EventTranslator} instance.
     *
     * @return A new EventTranslator.
     */
    EventTranslator create();
}