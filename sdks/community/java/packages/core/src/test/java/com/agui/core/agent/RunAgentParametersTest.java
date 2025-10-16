package com.agui.core.agent;

import com.agui.core.context.Context;
import com.agui.core.tool.Tool;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static java.util.Collections.emptyList;
import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("RunAgentParameters")
class RunAgentParametersTest {

    @Test
    void shouldCreateEmptyRunAgentParameters() {
        var sut = RunAgentParameters.empty();

        assertThat(sut.getRunId()).isNull();
        assertThat(sut.getForwardedProps()).isNull();
        assertThat(sut.getContext()).isEmpty();
        assertThat(sut.getTools()).isEmpty();
    }

    @Test
    void shouldCreateRunAgentParametersWithRunId() {
        var runId = UUID.randomUUID().toString();

        var sut = RunAgentParameters.withRunId(runId);

        assertThat(sut.getRunId()).isEqualTo(runId);
    }

    @Test
    void shouldCreateRunAgentParameters() {
        var runId = UUID.randomUUID().toString();
        List<Context> context = emptyList();
        List<Tool> tools = emptyList();
        var forwardedProps = "Props";

        var sut = RunAgentParameters.builder()
            .runId(runId)
            .context(context)
            .tools(tools)
            .forwardedProps(forwardedProps)
            .build();

        assertThat(sut.getRunId()).isEqualTo(runId);
        assertThat(sut.getContext()).isEqualTo(context);
        assertThat(sut.getTools()).isEqualTo(tools);
        assertThat(sut.getForwardedProps()).isEqualTo(forwardedProps);
    }


}