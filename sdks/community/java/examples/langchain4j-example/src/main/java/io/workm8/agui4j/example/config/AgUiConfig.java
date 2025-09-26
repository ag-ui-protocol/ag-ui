package io.workm8.agui4j.example.config;

import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.mcp.McpToolProvider;
import dev.langchain4j.mcp.client.DefaultMcpClient;
import dev.langchain4j.mcp.client.transport.stdio.StdioMcpTransport;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.ollama.OllamaChatModel;
import dev.langchain4j.model.ollama.OllamaStreamingChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.model.openai.OpenAiStreamingChatModel;
import dev.langchain4j.store.memory.chat.InMemoryChatMemoryStore;
import io.workm8.agui4j.core.exception.AGUIException;
import io.workm8.agui4j.example.DateTimeTool;
import io.workm8.agui4j.langchain4j.LangchainAgent;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;

import java.util.List;

@Configuration
public class AgUiConfig {

    @Bean
    @Primary
    public LangchainAgent localAgent() throws AGUIException {
        StreamingChatModel chatModel = OllamaStreamingChatModel.builder()
            .baseUrl("http://localhost:11434")
            .modelName("llama3.2")
            .build();

        var store = new InMemoryChatMemoryStore();

        var chatMemory = MessageWindowChatMemory.builder()
            .maxMessages(10)
            .chatMemoryStore(store)
            .build();

        var transport = new StdioMcpTransport.Builder()
            .command(List.of("docker", "run", "--rm", "-i", "mcp/sequentialthinking"))
            .logEvents(true)
            .build();

        var mcpClient = new DefaultMcpClient.Builder()
            .transport(transport)
            .build();

        var toolProvider = McpToolProvider.builder()
            .mcpClients(mcpClient)
            .build();

        return LangchainAgent.builder()
            .agentId("1")
            .streamingChatModel(chatModel)
            .chatModel(OllamaChatModel.builder()
                .baseUrl("http://localhost:11434")
                .modelName("llama3.2")
                .build()
            )
            .chatMemory(chatMemory)
            .systemMessageProvider((agent) -> "You are Moira, a smart AI agent. Be friendly to the user, use slang where needed.")
            .hallucinatedToolNameStrategy(toolExecutionRequest -> ToolExecutionResultMessage.from(
                toolExecutionRequest, "Error: there is no tool called " + toolExecutionRequest.name())
            )
            .build();
    }

    @Bean
    @Primary
    public LangchainAgent openAiAgent(@Value("${openai.api_key}") final String apiKey) throws AGUIException {
        StreamingChatModel chatModel = OpenAiStreamingChatModel.builder()
            .modelName("gpt-4.1-mini-2025-04-14")
            .apiKey(apiKey)
            .build();

        var store = new InMemoryChatMemoryStore();

        var chatMemory = MessageWindowChatMemory.builder()
            .maxMessages(10)
            .chatMemoryStore(store)
            .build();

        var transport = new StdioMcpTransport.Builder()
            .command(List.of("docker", "run", "--rm", "-i", "mcp/sequentialthinking"))
            .logEvents(true)
            .build();

        var mcpClient = new DefaultMcpClient.Builder()
                .transport(transport)
                .build();

        var toolProvider = McpToolProvider.builder()
                .mcpClients(mcpClient)
                .build();

        return LangchainAgent.builder()
                .agentId("1")
                .streamingChatModel(chatModel)
                .chatModel(
                    OpenAiChatModel.builder()
                        .modelName("gpt-4.1-mini-2025-04-14")
                        .apiKey(apiKey)
                        .build()
                )
                .tool(new DateTimeTool())
                .chatMemory(chatMemory)
                .systemMessageProvider((agent) -> "You are Moira, a smart AI agent. Be friendly to the user, use slang where needed.")
                .hallucinatedToolNameStrategy(toolExecutionRequest -> ToolExecutionResultMessage.from(
                    toolExecutionRequest, "Error: there is no tool called " + toolExecutionRequest.name())
                )
                .build();
    }
}
