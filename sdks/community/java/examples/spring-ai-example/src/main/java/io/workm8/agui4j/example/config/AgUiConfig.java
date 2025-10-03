package io.workm8.agui4j.example.config;

import io.workm8.agui4j.core.exception.AGUIException;
import io.workm8.agui4j.core.state.State;
import io.workm8.agui4j.example.tools.AsciiTool;
import io.workm8.agui4j.example.tools.WeatherRequest;
import io.workm8.agui4j.example.tools.WeatherTool;
import io.workm8.agui4j.spring.ai.SpringAIAgent;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.InMemoryChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.openai.api.OpenAiApi;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.function.FunctionToolCallback;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestTemplate;

@Configuration
public class AgUiConfig {

    @Bean
    public RestTemplate restTemplate() {
        return new RestTemplate();
    }

    @Bean
    public SpringAIAgent agent(@Value("${spring.ai.openai.api-key}") final String apiKey, final AsciiTool asciiTool) throws AGUIException {
        var openai = OpenAiChatModel.builder()
            .defaultOptions(OpenAiChatOptions.builder()
                .model("gpt-4o")
                .build()
            )
            .openAiApi(OpenAiApi.builder()
                .apiKey(apiKey)
                .build()
            )
            .build();

        ChatMemory chatMemory = MessageWindowChatMemory.builder()
            .chatMemoryRepository(new InMemoryChatMemoryRepository())
            .maxMessages(10)
            .build();

        var state = new State();

        ToolCallback toolCallback = FunctionToolCallback
            .builder("weatherTool", new WeatherTool())
            .description("Get the weather in location")
            .inputType(WeatherRequest.class)
            .build();

        return SpringAIAgent.builder()
            .agentId("1")
            .chatMemory(chatMemory)
            .chatModel(openai)
            .systemMessage("You are a helpful AI assistant, called Moira.")
            .state(state)
            .toolCallback(toolCallback)
            .tool(asciiTool)
            .build();
    }
}
