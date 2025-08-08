package io.workm8.agui.client;

import io.workm8.agui.context.Context;
import io.workm8.agui.tool.Tool;

import java.util.List;
import java.util.Optional;

public class RunAgentParameters {

    private final String runId;
    private final List<Tool> tools;
    private final List<Context> context;
    private final Object forwardedProps;

    private RunAgentParameters(Builder builder) {
        this.runId = builder.runId;
        this.tools = builder.tools;
        this.context = builder.context;
        this.forwardedProps = builder.forwardedProps;
    }

    public String getRunId() {
        return runId;
    }

    public List<Tool> getTools() {
        return tools;
    }

    public List<Context> getContext() {
        return context;
    }

    public Object getForwardedProps() {
        return forwardedProps;
    }

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
