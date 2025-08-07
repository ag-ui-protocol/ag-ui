package com.agui.client;

import io.workm8.agui.client.AbstractAgent;
import io.workm8.agui.event.BaseEvent;
import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.type.RunAgentInput;
import io.workm8.agui.type.State;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

public class TestAgent extends AbstractAgent {

    private final AtomicReference<Consumer<BaseEvent>> eventHandlerRef = new AtomicReference<>();
    private final AtomicReference<CompletableFuture<Void>> runFutureRef = new AtomicReference<>();
    private final AtomicBoolean isRunning = new AtomicBoolean(false);

    public TestAgent(String agentId, String description, String threadId, List<BaseMessage> messages, State state, boolean debug) {
        super(agentId, description, threadId, messages, state, debug);
    }

    @Override
    protected CompletableFuture<Void> run(RunAgentInput input, Consumer<BaseEvent> eventHandler) {
        // Store the event handler for later use
        eventHandlerRef.set(eventHandler);
        isRunning.set(true);

        // Create a CompletableFuture that we'll complete manually
        CompletableFuture<Void> future = new CompletableFuture<>();
        runFutureRef.set(future);

        // Handle cancellation
        future.whenComplete((result, throwable) -> {
            if (future.isCancelled()) {
                isRunning.set(false);
                eventHandlerRef.set(null);
            }
        });

        return future;
    }

    /**
     * Emit an event to the current event handler (if running)
     *
     * @param event The event to emit
     */
    public void emitEvent(BaseEvent event) {
        Consumer<BaseEvent> handler = eventHandlerRef.get();
        if (handler != null && isRunning.get()) {
            try {
                handler.accept(event);
            } catch (Exception e) {
                System.err.println("Error emitting event: " + e.getMessage());
                if (debug) {
                    e.printStackTrace();
                }
            }
        }
    }

    /**
     * Complete the agent run successfully
     */
    public void complete() {
        CompletableFuture<Void> future = runFutureRef.get();
        if (future != null && !future.isDone()) {
            isRunning.set(false);
            eventHandlerRef.set(null);
            future.complete(null);
        }
    }

    /**
     * Fail the agent run with an error
     *
     * @param t The throwable that caused the failure
     */
    public void fail(Throwable t) {
        CompletableFuture<Void> future = runFutureRef.get();
        if (future != null && !future.isDone()) {
            isRunning.set(false);
            eventHandlerRef.set(null);
            future.completeExceptionally(t);
        }
    }

    /**
     * Check if the agent is currently running
     *
     * @return true if the agent is running, false otherwise
     */
    public boolean isRunning() {
        return isRunning.get();
    }

    /**
     * Cancel the current run if it's active
     */
    public void cancel() {
        CompletableFuture<Void> future = runFutureRef.get();
        if (future != null && !future.isDone()) {
            future.cancel(true);
        }
    }

    /**
     * Utility method to emit multiple events in sequence
     *
     * @param events The events to emit
     */
    public void emitEvents(BaseEvent... events) {
        for (BaseEvent event : events) {
            emitEvent(event);
        }
    }

    /**
     * Utility method to emit multiple events from a list
     *
     * @param events The list of events to emit
     */
    public void emitEvents(List<BaseEvent> events) {
        for (BaseEvent event : events) {
            emitEvent(event);
        }
    }

    /**
     * Builder pattern for easier test agent creation
     */
    public static class Builder {
        private String agentId;
        private String description = "";
        private String threadId;
        private List<BaseMessage> messages;
        private State state;
        private boolean debug = false;

        public Builder agentId(String agentId) {
            this.agentId = agentId;
            return this;
        }

        public Builder description(String description) {
            this.description = description;
            return this;
        }

        public Builder threadId(String threadId) {
            this.threadId = threadId;
            return this;
        }

        public Builder messages(List<BaseMessage> messages) {
            this.messages = messages;
            return this;
        }

        public Builder state(State state) {
            this.state = state;
            return this;
        }

        public Builder debug(boolean debug) {
            this.debug = debug;
            return this;
        }

        public Builder debug() {
            this.debug = true;
            return this;
        }

        public TestAgent build() {
            return new TestAgent(agentId, description, threadId, messages, state, debug);
        }
    }

    public static Builder builder() {
        return new Builder();
    }
}