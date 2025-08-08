package com.agui;


import io.workm8.agui.HttpAgent;
import io.workm8.agui.client.RunAgentParameters;
import io.workm8.agui.client.subscriber.AgentSubscriberParams;
import io.workm8.agui.event.BaseEvent;
import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.message.UserMessage;
import io.workm8.agui.okhttp.HttpClient;
import io.workm8.agui.client.subscriber.AgentSubscriber;
import io.workm8.agui.state.State;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

public class HttpAgentTest {

    @Test
    public void itShouldCallEndpoint() throws InterruptedException {
        var message = new UserMessage();
        message.setContent("Hi, what's the weather in Paris?");

        var agent = HttpAgent.withAgentId("simpleAgent")
            .threadId("THREAD")
            .description("Agent Description")
            .httpClient(new HttpClient("http://localhost:3033/ai/mastra/run/weatherAgent"))
            .state(new State())
            .addMessage(message)
            .debug()
            .build();

        var parameters = RunAgentParameters.builder()
            .runId("1")
            .build();

        var messages = new ArrayList<BaseMessage>();

        CountDownLatch latch = new CountDownLatch(1);
        List<BaseEvent> receivedEvents = new ArrayList<>();
        AtomicReference<Throwable> error = new AtomicReference<>();

        agent.runAgent(parameters, new AgentSubscriber() {
            @Override
            public void onEvent(BaseEvent event) {
                receivedEvents.add(event);
                System.out.println("Received event: " + event);
            }

            @Override
            public void onNewMessage(BaseMessage m) {
                messages.add(m);
            }

            @Override
            public void onRunFinalized(AgentSubscriberParams params) {
                System.out.println("Agent completed successfully");
                latch.countDown();
            }

            @Override
            public void onRunFailed(AgentSubscriberParams params, Throwable throwable) {
                System.err.println("Error occurred: " + throwable.getMessage());
                error.set(throwable);
                latch.countDown();
            }
        });

        // Wait up to 30 seconds for completion
        boolean completed = latch.await(30, TimeUnit.SECONDS);

        assertThat(completed).isTrue();
        assertThat(error.get()).isNull();
        assertThat(receivedEvents.size()).isGreaterThan(0);

        System.out.println("Test completed successfully with " + receivedEvents.size() + " events");

    }

}