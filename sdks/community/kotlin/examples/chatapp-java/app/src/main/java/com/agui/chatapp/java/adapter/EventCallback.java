package com.agui.chatapp.java.adapter;

import com.agui.core.types.BaseEvent;

/**
 * Java callback interface for handling AG-UI events.
 * Provides a Java-friendly alternative to Kotlin Flow.
 */
public interface EventCallback {
    
    /**
     * Called when a new event is received from the agent
     * @param event The event received from the agent
     */
    void onEvent(BaseEvent event);
    
    /**
     * Called when an error occurs during event processing
     * @param error The error that occurred
     */
    void onError(Throwable error);
    
    /**
     * Called when the event stream completes
     */
    void onComplete();
}