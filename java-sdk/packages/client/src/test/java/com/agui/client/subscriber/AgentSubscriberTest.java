package com.agui.client.subscriber;

import io.workm8.agui.client.RunAgentParameters;
import io.workm8.agui.client.subscriber.AgentSubscriber;
import io.workm8.agui.client.subscriber.AgentSubscriberParams;
import io.workm8.agui.type.State;
import com.agui.client.TestAgent;
import org.junit.jupiter.api.Test;

import java.util.Collections;

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
                public void onRunInitialized(AgentSubscriberParams params) {
                    assertThat(params.getAgent()).isEqualTo(agent);
                    assertThat(params.getInput().threadId()).isEqualTo("THREAD_ID");
                    assertThat(params.getInput().runId()).isEqualTo("RUN_ID");
                    assertThat(params.getInput().context()).hasSize(0);
                    assertThat(params.getInput().messages()).hasSize(0);
                    assertThat(params.getInput().tools()).hasSize(0);

                    assertThat(params.getMessages()).hasSize(0);
                    assertThat(params.getState()).isEqualTo(agent.getState());
                }
            }
        );

        agent.runAgent(RunAgentParameters.builder().build(), new AgentSubscriber() {});
    }
}