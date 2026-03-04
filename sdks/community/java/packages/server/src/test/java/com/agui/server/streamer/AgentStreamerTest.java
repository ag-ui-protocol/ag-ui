package com.agui.server.streamer;


import com.agui.core.agent.Agent;
import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.RawEvent;
import com.agui.core.message.BaseMessage;
import com.agui.core.stream.EventStream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.*;

@DisplayName("AgentStreamer")
class AgentStreamerTest {

    @Test
    void itShouldRunAgentStreamer() {
        var sut = new AgentStreamer();
        var agent = new TestAgent();
        var id = UUID.randomUUID().toString();
        var parameters = RunAgentParameters.withRunId(id);
        var event = new RawEvent();
        EventStream<BaseEvent> eventStream = new EventStream<>(
            evt -> {
                assertThat(evt).isEqualTo(event);
            },
            err -> {},
            () -> {}
        );

        sut.streamEvents(agent, parameters, eventStream);
        agent.subscriber.onEvent(event);
    }

    @Test
    void itShouldThrowError() {
        var sut = new AgentStreamer();
        var agent = new TestAgent();
        var id = UUID.randomUUID().toString();
        var parameters = RunAgentParameters.withRunId(id);
        var error = new RuntimeException("Exception");
        EventStream<BaseEvent> eventStream = new EventStream<>(
            evt -> { },
            err -> assertThat(err).isEqualTo(error),
            () -> {}
        );

        sut.streamEvents(agent, parameters, eventStream);
        agent.subscriber.onRunFailed(null, error);
    }

    @Test
    void itShouldComplete() {
        AtomicBoolean completeCalled = new AtomicBoolean(false);

        var sut = new AgentStreamer();
        var agent = new TestAgent();
        var id = UUID.randomUUID().toString();
        var parameters = RunAgentParameters.withRunId(id);

        EventStream<BaseEvent> eventStream = new EventStream<>(
            evt -> { },
            err -> { },
            () -> completeCalled.set(true)
        );

        sut.streamEvents(agent, parameters, eventStream);
        agent.subscriber.onRunFinalized(null);
        assertThat(completeCalled.get()).isTrue();
    }

    public static class TestAgent implements Agent {

        public AgentSubscriber subscriber;

        @Override
        public CompletableFuture<Void> runAgent(RunAgentParameters parameters, AgentSubscriber subscriber) {
            this.subscriber = subscriber;
            return CompletableFuture.runAsync(() -> { });
        }

        @Override
        public List<BaseMessage> getMessages() {
            return Collections.emptyList();
        }
    }
}