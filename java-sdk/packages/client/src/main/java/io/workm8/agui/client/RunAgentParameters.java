package io.workm8.agui.client;

import io.workm8.agui.type.Context;
import io.workm8.agui.type.Tool;

import java.util.List;
import java.util.Optional;

public class RunAgentParameters {

    private final Optional<String> runId;
    private final Optional<List<Tool>> tools;
    private final Optional<List<Context>> context;
    private final Optional<Object> forwardedProps;

    // Private constructor for builder pattern
    private RunAgentParameters(Builder builder) {
        this.runId = Optional.ofNullable(builder.runId);
        this.tools = Optional.ofNullable(builder.tools);
        this.context = Optional.ofNullable(builder.context);
        this.forwardedProps = Optional.ofNullable(builder.forwardedProps);
    }

    // Getters
    public Optional<String> getRunId() {
        return runId;
    }

    public Optional<List<Tool>> getTools() {
        return tools;
    }

    public Optional<List<Context>> getContext() {
        return context;
    }

    public Optional<Object> getForwardedProps() {
        return forwardedProps;
    }

    // Builder pattern for easy construction
    public static class Builder {
        private String runId;
        private List<Tool> tools;
        private List<Context> context;
        private Object forwardedProps;

        public Builder runId(String runId) {
            this.runId = runId;
            return this;
        }

        public Builder tools(List<Tool> tools) {
            this.tools = tools;
            return this;
        }

        public Builder context(List<Context> context) {
            this.context = context;
            return this;
        }

        public Builder forwardedProps(Object forwardedProps) {
            this.forwardedProps = forwardedProps;
            return this;
        }

        public RunAgentParameters build() {
            return new RunAgentParameters(this);
        }
    }

    // Static factory method
    public static Builder builder() {
        return new Builder();
    }

    // Convenience factory methods
    public static RunAgentParameters empty() {
        return new Builder().build();
    }

    public static RunAgentParameters withRunId(String runId) {
        return new Builder().runId(runId).build();
    }
}
