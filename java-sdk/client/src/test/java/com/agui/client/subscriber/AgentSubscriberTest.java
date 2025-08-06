package com.agui.client.subscriber;


import com.agui.client.RunAgentParameters;
import com.agui.client.State;
import com.agui.client.TestAgent;
import com.agui.types.RunAgentInput;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.as;
import static org.assertj.core.api.Assertions.assertThat;

class AgentSubscriberTest {

    @Test
    public void testOnRunInitialized() {
        var agent = new TestAgent(
            "agent",
            "TESTING",
            "THREAD_ID",
            Collections.emptyList(),
            new State(),
            true
        );

        var params = RunAgentParameters
            .builder()
            .runId("RUN_ID")
            .context(Collections.emptyList())
            .tools(Collections.emptyList())
            .build();

        agent.runAgent(
            params,
            new AgentSubscriber() {
                @Override
                public CompletableFuture<AgentStateMutation> onRunInitialized(AgentSubscriberParams params) {
                    assertThat(params.getAgent()).isEqualTo(agent);
                    assertThat(params.getInput().getThreadId()).isEqualTo("THREAD_ID");
                    assertThat(params.getInput().getRunId()).isEqualTo("RUN_ID");
                    assertThat(params.getInput().getContext()).hasSize(0);
                    assertThat(params.getInput().getMessages()).hasSize(0);
                    assertThat(params.getInput().getTools()).hasSize(0);

                    assertThat(params.getMessages()).hasSize(0);
                    assertThat(params.getState()).isEqualTo(agent.getState());

                    return AgentSubscriber.super.onRunInitialized(params);
                }
            }
        );

        agent.runAgent(RunAgentParameters.builder()
                .build(), new AgentSubscriber() {});
    }
}