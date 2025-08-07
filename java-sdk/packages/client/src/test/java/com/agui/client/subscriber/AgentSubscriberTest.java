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

                    assertThat(params.agent()).isEqualTo(agent);
                    assertThat(params.input().threadId()).isEqualTo("THREAD_ID");
                    assertThat(params.input().runId()).isEqualTo("RUN_ID");
                    assertThat(params.input().context()).hasSize(0);
                    assertThat(params.input().messages()).hasSize(0);
                    assertThat(params.input().tools()).hasSize(0);

                    assertThat(params.messages()).hasSize(0);
                    assertThat(params.state()).isEqualTo(agent.getState());
                }
            }
        );

        agent.runAgent(RunAgentParameters.builder().build(), new AgentSubscriber() {});
    }
}