package com.agui.server;

import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.AgentSubscriberParams;
import com.agui.core.agent.RunAgentInput;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.*;
import com.agui.core.exception.AGUIException;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.UserMessage;
import com.agui.core.state.State;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.function.BiConsumer;
import java.util.function.Function;

import static java.util.Arrays.asList;
import static java.util.Collections.emptyList;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;
import static org.junit.jupiter.api.Assertions.*;

@DisplayName("LocalAgent")
class LocalAgentTest {

    @Test
    public void shouldCreateAgentWithSystemMessage() throws AGUIException {
        var agentId = UUID.randomUUID().toString();
        var systemMessage = "Static System Message";
        var agent = new TestAgent(agentId, new State(), null, systemMessage);

        assertThat(agent.getSystemMessage())
            .contains(systemMessage);
    }

    @Test
    public void shouldCreateAgentWithSystemMessageFromProvider() throws AGUIException {
        var agentId = UUID.randomUUID().toString();
        var systemMessage = "Dynamic system message";
        var systemMessageProvider = new Function<LocalAgent, String>() {
            @Override
            public String apply(LocalAgent localAgent) {
                return systemMessage;
            }
        };

        var agent = new TestAgent(agentId, new State(), systemMessageProvider, null);

        assertThat(agent.getSystemMessage())
                .contains(systemMessage);
    }

    @Test
    public void shouldThrowExceptionOnNullSystemMessageAndProvider() throws AGUIException {
        assertThatExceptionOfType(AGUIException.class)
            .isThrownBy(() -> new TestAgent(null, new State(), null, null))
            .withMessage("Either SystemMessage or SystemMessageProvider should be set.");
    }

    @Test
    public void shouldGetLatestUserMessage() throws AGUIException {
        var message1 = new UserMessage();
        message1.setContent("Hi");
        var message2 = new UserMessage();
        message2.setContent("Bye");

        var agent = new TestAgent(null, null, null, "System");

        assertThat(agent.getLatestUserMessageContent(asList(message1, message2)))
            .isEqualTo("Bye");
    }

    @Test
    public void shouldThrowExceptionOnNoUserMessage() throws AGUIException {
        var agent = new TestAgent(null, null, null,"System");

        assertThatExceptionOfType(AGUIException.class)
            .isThrownBy(() -> agent.getLatestUserMessageContent(emptyList()))
            .withMessage("No User Message found.");
    }

    @Test
    public void shouldSetAgentId() throws AGUIException {
        var agentId = UUID.randomUUID().toString();
        var agent = new TestAgent(agentId, new State(), null, "Message");

        assertThat(agent.getAgentId()).isEqualTo(agentId);
    }

    @Test
    public void shouldRunAgent() throws AGUIException {
        var message = new UserMessage();
        message.setContent("Hi");
        var agent = new TestAgent(null, null, null, "System");
        var runId = UUID.randomUUID().toString();

        agent.runAgent(
            RunAgentParameters.builder()
                .runId(runId)
                .messages(List.of(message))
                .tools(emptyList())
                .threadId("thread-1")
                .build(),
            new AgentSubscriber() {
                @Override
                public void onRunFinalized(AgentSubscriberParams params) {
                    assertThat(agent.input.messages()).containsExactly(message);
                }
                @Override
                public void onRunFailed(AgentSubscriberParams params, Throwable error) {
                    AgentSubscriber.super.onRunFailed(params, error);
                }
            }
        ).whenComplete((unused, throwable) -> {
            assertThat(agent.input.messages()).containsExactly(message);
        });
    }

    @Test
    public void shouldEmitEvents() throws AGUIException {
        var agent = new TestAgent(null, null, null, "Message");

        var agentSubscriber = new AgentSubscriber(){
            private List<BaseEvent> events = new ArrayList<>();

            @Override
            public void onEvent(BaseEvent event) {
                events.add(event);
            }

            public BaseEvent getLastEvent() {
                return this.events
                    .stream()
                    .reduce((first, second) -> second)
                    .orElse(null);
            }
        };

        var runStartedEvent = new RunStartedEvent();
        agent.emitEvent(runStartedEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(runStartedEvent);

        var runErrorEvent = new RunErrorEvent();
        agent.emitEvent(runErrorEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(runErrorEvent);

        var runFinishedEvent = new RunFinishedEvent();
        agent.emitEvent(runFinishedEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(runFinishedEvent);

        var customEvent = new CustomEvent();
        agent.emitEvent(customEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(customEvent);

        var rawEvent = new RawEvent();
        agent.emitEvent(rawEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(rawEvent);

        var stepStartedEvent = new StepStartedEvent();
        agent.emitEvent(stepStartedEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(stepStartedEvent);

        var stepFinishedEvent = new StepFinishedEvent();
        agent.emitEvent(stepFinishedEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(stepFinishedEvent);

        var textMessageStartEvent = new TextMessageStartEvent();
        agent.emitEvent(textMessageStartEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(textMessageStartEvent);

        var textMessageChunkEvent = new TextMessageChunkEvent();
        agent.emitEvent(textMessageChunkEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(textMessageChunkEvent);

        var textMessageContentEvent = new TextMessageContentEvent();
        agent.emitEvent(textMessageContentEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(textMessageContentEvent);

        var textMessageEndEvent = new TextMessageEndEvent();
        agent.emitEvent(textMessageEndEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(textMessageEndEvent);

        var toolCallStartEvent = new ToolCallStartEvent();
        agent.emitEvent(toolCallStartEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(toolCallStartEvent);

        var toolCallArgsEvent = new ToolCallArgsEvent();
        agent.emitEvent(toolCallArgsEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(toolCallArgsEvent);

        var toolCallChunkEvent = new ToolCallChunkEvent();
        agent.emitEvent(toolCallChunkEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(toolCallChunkEvent);

        var toolCallResultEvent = new ToolCallResultEvent();
        agent.emitEvent(toolCallResultEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(toolCallResultEvent);

        var toolCallEndEvent = new ToolCallEndEvent();
        agent.emitEvent(toolCallEndEvent, agentSubscriber);
        assertThat(agentSubscriber.getLastEvent()).isEqualTo(toolCallEndEvent);
    }


    @Test
    public void shouldSetState() throws AGUIException {
        var agent = new TestAgent(null, null, null, "Message");

        var state = new State();

        assertThat(agent.state).isNull();

        agent.setState(state);

        assertThat(agent.state).isEqualTo(state);
    }

    public static class TestAgent extends LocalAgent {

        RunAgentInput input;

        public TestAgent(String agentId, State state, Function<LocalAgent, String> systemMessageProvider, String systemMessage) throws AGUIException {
            super(agentId, state, systemMessageProvider, systemMessage, new ArrayList<>());
        }

        @Override
        public List<BaseMessage> getMessages() {
            return List.of();
        }

        @Override
        protected void run(RunAgentInput input, AgentSubscriber subscriber) {
            this.input = input;
        }

        public String getSystemMessage() {
            return super.createSystemMessage(new State(), emptyList()).getContent();
        }

        public String getLatestUserMessageContent(List<BaseMessage> messages) throws AGUIException {
            return super.getLatestUserMessage(messages).getContent();
        }
    }
}