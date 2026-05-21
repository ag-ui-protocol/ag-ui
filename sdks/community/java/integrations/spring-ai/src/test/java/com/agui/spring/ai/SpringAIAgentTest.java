package com.agui.spring.ai;

import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.RunAgentInput;
import com.agui.core.context.Context;
import com.agui.core.event.BaseEvent;
import com.agui.core.message.BaseMessage;
import com.agui.core.state.State;
import com.agui.core.type.EventType;
import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static java.util.Collections.emptyList;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class SpringAIAgentTest {

    @Test
    void shouldEmitToolEventsBeforeCompletingMessage() throws Exception {
        var agent = SpringAIAgent.builder()
                .agentId("test-agent")
                .chatModel(mock(ChatModel.class))
                .state(new State())
                .messages(new ArrayList<>())
                .systemMessage("You are helpful.")
                .build();

        var capturedEvents = new ArrayList<BaseEvent>();
        var subscriber = new AgentSubscriber() {
            @Override
            public void onEvent(BaseEvent event) {
                capturedEvents.add(event);
            }
        };

        var messageId = "message-1";
        var assistantMessage = new com.agui.core.message.AssistantMessage();
        var springToolCall = new org.springframework.ai.chat.messages.AssistantMessage.ToolCall(
                "call-1",
                "function",
                "get_weather",
                "{\"city\":\"Paris\"}"
        );
        var springAssistantMessage = new org.springframework.ai.chat.messages.AssistantMessage(
                "",
                Map.of(),
                List.of(springToolCall)
        );
        var response = new ChatResponse(List.of(new Generation(springAssistantMessage)));

        invokeOnEvent(agent, subscriber, response, assistantMessage, messageId);

        var typesBeforeComplete = capturedEvents.stream().map(BaseEvent::getType).toList();
        assertThat(typesBeforeComplete).containsExactly(
                EventType.TOOL_CALL_START,
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_END
        );

        var input = new RunAgentInput(
                "thread-1",
                "run-1",
                new State(),
                List.<BaseMessage>of(),
                emptyList(),
                List.<Context>of(),
                null
        );

        invokeOnComplete(agent, input, assistantMessage, subscriber, messageId);

        var types = capturedEvents.stream().map(BaseEvent::getType).toList();
        assertThat(types).containsExactly(
                EventType.TOOL_CALL_START,
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_END,
                EventType.TEXT_MESSAGE_END,
                EventType.RUN_FINISHED
        );
    }

    private static void invokeOnEvent(
            SpringAIAgent agent,
            AgentSubscriber subscriber,
            ChatResponse response,
            com.agui.core.message.AssistantMessage assistantMessage,
            String messageId
    ) throws Exception {
        Method onEvent = SpringAIAgent.class.getDeclaredMethod(
                "onEvent",
                AgentSubscriber.class,
                ChatResponse.class,
                com.agui.core.message.AssistantMessage.class,
                String.class
        );
        onEvent.setAccessible(true);
        onEvent.invoke(agent, subscriber, response, assistantMessage, messageId);
    }

    private static void invokeOnComplete(
            SpringAIAgent agent,
            RunAgentInput input,
            com.agui.core.message.AssistantMessage assistantMessage,
            AgentSubscriber subscriber,
            String messageId
    ) throws Exception {
        Method onComplete = SpringAIAgent.class.getDeclaredMethod(
                "onComplete",
                RunAgentInput.class,
                com.agui.core.message.AssistantMessage.class,
                AgentSubscriber.class,
                String.class
        );
        onComplete.setAccessible(true);
        onComplete.invoke(agent, input, assistantMessage, subscriber, messageId);
    }
}
