package com.agui.adk;

/**
 * The default implementation of the {@link EventTranslatorFactory}.
 */
public class DefaultEventTranslatorFactory implements EventTranslatorFactory {
    @Override
    public EventTranslator create() {
        return new EventTranslator();
    }
}