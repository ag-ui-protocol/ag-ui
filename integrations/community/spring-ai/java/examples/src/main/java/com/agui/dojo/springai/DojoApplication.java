package com.agui.dojo.springai;

import com.agui.community.core.agent.Agent;
import com.agui.community.spring.ai.SpringAiAgent;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

/**
 * The Spring AI server for the AG-UI Dojo.
 *
 * <p>Each {@link Agent} bean is registered under its bean name and served by the
 * SDK's WebMVC endpoint at {@code POST /agent/{beanName}}. The bean names match the
 * Dojo feature ids in {@code apps/dojo/src/agents.ts}.
 *
 * <p>Frontend tools (agentic chat, tool-based generative UI, human in the loop) come
 * from the run input, so those agents only need a system prompt. The shared-state
 * agents turn on the SDK's {@code update_state} tool.
 */
@SpringBootApplication
public class DojoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DojoApplication.class, args);
    }

    private static ChatClient client(ChatClient.Builder builder, String system) {
        return builder.clone().defaultSystem(system).build();
    }

    @Bean
    Agent agentic_chat(ChatClient.Builder builder) {
        return SpringAiAgent.builder(client(builder, "You are a helpful assistant.")).build();
    }

    @Bean
    Agent tool_based_generative_ui(ChatClient.Builder builder) {
        return SpringAiAgent.builder(client(builder,
                "You are a helpful assistant. When the user asks for a haiku, call the"
                        + " generate_haiku tool instead of writing it in the reply.")).build();
    }

    @Bean
    Agent human_in_the_loop(ChatClient.Builder builder) {
        return SpringAiAgent.builder(client(builder,
                "You are a helpful assistant. When the user asks you to perform a task,"
                        + " break it into steps and call the generate_task_steps tool so the"
                        + " user can review them before you continue.")).build();
    }

    @Bean
    Agent shared_state(ChatClient.Builder builder) {
        return SpringAiAgent.builder(client(builder,
                        "You are a helpful cooking assistant. Keep the recipe in the shared"
                                + " state up to date with the user's requests."))
                .shareState(true)
                .build();
    }

    @Bean
    Agent agentic_generative_ui(ChatClient.Builder builder) {
        return SpringAiAgent.builder(client(builder,
                        "You are a helpful assistant. Plan the user's task as a list of steps in"
                                + " the shared state ({\"steps\": [{\"description\": ...,"
                                + " \"status\": \"pending\" | \"completed\"}]}) and mark each step"
                                + " completed as you go."))
                .shareState(true)
                .stateUpdates(SpringAiAgent.StateUpdates.DELTA)
                .build();
    }
}
