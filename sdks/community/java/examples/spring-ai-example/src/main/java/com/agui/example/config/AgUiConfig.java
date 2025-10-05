package com.agui.example.config;

import com.agui.core.exception.AGUIException;
import com.agui.core.state.State;
import com.agui.example.tools.AsciiTool;
import com.agui.example.tools.WeatherRequest;
import com.agui.example.tools.WeatherTool;
import com.agui.spring.ai.SpringAIAgent;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.InMemoryChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.ai.chat.model.ChatModel;
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

    @Bean("AgenticChat")
    public SpringAIAgent agenticChatAgent(@Value("${spring.ai.openai.api-key}") final String apiKey) throws AGUIException {
        var openai = chatModel(apiKey);

        ChatMemory chatMemory = MessageWindowChatMemory.builder()
            .chatMemoryRepository(new InMemoryChatMemoryRepository())
            .maxMessages(10)
            .build();

        var state = new State();

        return SpringAIAgent.builder()
            .agentId("1")
            .chatMemory(chatMemory)
            .chatModel(openai)
            .systemMessage("You are a helpful AI assistant, called Moira.")
            .state(state)
            .build();
    }

    @Bean("SharedState")
    public SpringAIAgent sharedStateAgent(@Value("${spring.ai.openai.api-key}") final String apiKey) throws AGUIException {
        var openai = chatModel(apiKey);

        ChatMemory chatMemory = MessageWindowChatMemory.builder()
                .chatMemoryRepository(new InMemoryChatMemoryRepository())
                .maxMessages(10)
                .build();

        var state = new State();

        state.set("Language", "Dutch");

        return SpringAIAgent.builder()
            .agentId("1")
            .chatMemory(chatMemory)
            .chatModel(openai)
            .systemMessage("You are a helpful AI assistant, called Moira.")
            .state(state)
            .build();
    }

    private ChatModel chatModel(final String apiKey) {
        return OpenAiChatModel.builder()
            .defaultOptions(OpenAiChatOptions.builder()
                .model("gpt-4o")
                .build()
            )
            .openAiApi(OpenAiApi.builder()
                .apiKey(apiKey)
                .build()
            )
            .build();
    }

}
