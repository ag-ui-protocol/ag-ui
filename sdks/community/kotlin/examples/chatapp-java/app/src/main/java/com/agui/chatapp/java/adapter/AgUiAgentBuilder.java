package com.agui.chatapp.java.adapter;

import com.agui.client.AgUiAgentConfig;
import com.agui.client.StatefulAgUiAgent;
import com.agui.tools.ToolRegistry;

/**
 * Java-friendly builder for creating AG-UI agents.
 * Provides a fluent API alternative to Kotlin DSL.
 */
public class AgUiAgentBuilder {
    private final String url;
    private final AgUiAgentConfig config;
    
    private AgUiAgentBuilder(String url) {
        this.url = url;
        this.config = new AgUiAgentConfig();
    }
    
    /**
     * Create a new builder for the specified agent URL
     * @param url The agent endpoint URL
     * @return A new builder instance
     */
    public static AgUiAgentBuilder create(String url) {
        return new AgUiAgentBuilder(url);
    }
    
    /**
     * Set the bearer token for authentication
     * @param token The bearer token
     * @return This builder for chaining
     */
    public AgUiAgentBuilder bearerToken(String token) {
        config.setBearerToken(token);
        return this;
    }
    
    /**
     * Set the API key for authentication
     * @param apiKey The API key
     * @return This builder for chaining
     */
    public AgUiAgentBuilder apiKey(String apiKey) {
        config.setApiKey(apiKey);
        return this;
    }
    
    /**
     * Set the API key header name
     * @param headerName The header name for the API key
     * @return This builder for chaining
     */
    public AgUiAgentBuilder apiKeyHeader(String headerName) {
        config.setApiKeyHeader(headerName);
        return this;
    }
    
    /**
     * Set the system prompt
     * @param prompt The system prompt
     * @return This builder for chaining
     */
    public AgUiAgentBuilder systemPrompt(String prompt) {
        config.setSystemPrompt(prompt);
        return this;
    }
    
    /**
     * Enable debug mode
     * @param debug Whether to enable debug mode
     * @return This builder for chaining
     */
    public AgUiAgentBuilder debug(boolean debug) {
        config.setDebug(debug);
        return this;
    }
    
    /**
     * Set the tool registry
     * @param toolRegistry The tool registry to use
     * @return This builder for chaining
     */
    public AgUiAgentBuilder toolRegistry(ToolRegistry toolRegistry) {
        config.setToolRegistry(toolRegistry);
        return this;
    }
    
    /**
     * Set the user ID
     * @param userId The user ID for message attribution
     * @return This builder for chaining
     */
    public AgUiAgentBuilder userId(String userId) {
        config.setUserId(userId);
        return this;
    }
    
    /**
     * Set request timeout in milliseconds
     * @param timeoutMs Timeout in milliseconds
     * @return This builder for chaining
     */
    public AgUiAgentBuilder requestTimeout(long timeoutMs) {
        config.setRequestTimeout(timeoutMs);
        return this;
    }
    
    /**
     * Set connection timeout in milliseconds
     * @param timeoutMs Timeout in milliseconds
     * @return This builder for chaining
     */
    public AgUiAgentBuilder connectTimeout(long timeoutMs) {
        config.setConnectTimeout(timeoutMs);
        return this;
    }
    
    /**
     * Add a custom header
     * @param name Header name
     * @param value Header value
     * @return This builder for chaining
     */
    public AgUiAgentBuilder addHeader(String name, String value) {
        config.getHeaders().put(name, value);
        return this;
    }
    
    /**
     * Build a stateful agent with the configured settings
     * @return A new StatefulAgUiAgent instance
     */
    public StatefulAgUiAgent buildStateful() {
        return new StatefulAgUiAgent(url, config -> {
            // Copy configuration properties
            config.setBearerToken(this.config.getBearerToken());
            config.setApiKey(this.config.getApiKey());
            config.setApiKeyHeader(this.config.getApiKeyHeader());
            config.setSystemPrompt(this.config.getSystemPrompt());
            config.setDebug(this.config.getDebug());
            config.setToolRegistry(this.config.getToolRegistry());
            config.setUserId(this.config.getUserId());
            config.setRequestTimeout(this.config.getRequestTimeout());
            config.setConnectTimeout(this.config.getConnectTimeout());
            config.getHeaders().putAll(this.config.getHeaders());
            return null; // Kotlin Unit return
        });
    }
}