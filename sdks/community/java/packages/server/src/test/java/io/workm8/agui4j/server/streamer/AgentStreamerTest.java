package io.workm8.agui4j.server.streamer;

import io.workm8.agui4j.core.agent.Agent;
import io.workm8.agui4j.core.agent.AgentSubscriber;
import io.workm8.agui4j.core.agent.RunAgentParameters;
import io.workm8.agui4j.core.event.BaseEvent;
import io.workm8.agui4j.core.event.RawEvent;
import io.workm8.agui4j.core.stream.EventStream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

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
    }
}