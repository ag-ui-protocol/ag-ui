package com.agui.chatapp.java.repository;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Repository for managing agent configuration using SharedPreferences.
 * Provides persistent storage for agent settings across app sessions.
 */
public class AgentRepository {
    private static final String PREF_NAME = "agent_settings";
    private static final String KEY_AGENT_URL = "agent_url";
    private static final String KEY_AUTH_TYPE = "auth_type";
    private static final String KEY_BEARER_TOKEN = "bearer_token";
    private static final String KEY_API_KEY = "api_key";
    private static final String KEY_API_KEY_HEADER = "api_key_header";
    private static final String KEY_SYSTEM_PROMPT = "system_prompt";
    private static final String KEY_DEBUG = "debug";
    
    public enum AuthType {
        NONE("none"),
        BEARER("bearer"),
        API_KEY("api_key");
        
        private final String value;
        
        AuthType(String value) {
            this.value = value;
        }
        
        public String getValue() {
            return value;
        }
        
        public static AuthType fromValue(String value) {
            for (AuthType type : values()) {
                if (type.value.equals(value)) {
                    return type;
                }
            }
            return NONE;
        }
    }
    
    public static class AgentConfig {
        private String agentUrl;
        private AuthType authType;
        private String bearerToken;
        private String apiKey;
        private String apiKeyHeader;
        private String systemPrompt;
        private boolean debug;
        
        public AgentConfig() {
            this.agentUrl = "";
            this.authType = AuthType.NONE;
            this.bearerToken = "";
            this.apiKey = "";
            this.apiKeyHeader = "x-api-key";
            this.systemPrompt = "";
            this.debug = false;
        }
        
        // Getters and setters
        public String getAgentUrl() { return agentUrl; }
        public void setAgentUrl(String agentUrl) { this.agentUrl = agentUrl; }
        
        public AuthType getAuthType() { return authType; }
        public void setAuthType(AuthType authType) { this.authType = authType; }
        
        public String getBearerToken() { return bearerToken; }
        public void setBearerToken(String bearerToken) { this.bearerToken = bearerToken; }
        
        public String getApiKey() { return apiKey; }
        public void setApiKey(String apiKey) { this.apiKey = apiKey; }
        
        public String getApiKeyHeader() { return apiKeyHeader; }
        public void setApiKeyHeader(String apiKeyHeader) { this.apiKeyHeader = apiKeyHeader; }
        
        public String getSystemPrompt() { return systemPrompt; }
        public void setSystemPrompt(String systemPrompt) { this.systemPrompt = systemPrompt; }
        
        public boolean isDebug() { return debug; }
        public void setDebug(boolean debug) { this.debug = debug; }
        
        public boolean isValid() {
            return agentUrl != null && !agentUrl.trim().isEmpty();
        }
        
        public boolean hasAuthentication() {
            switch (authType) {
                case BEARER:
                    return bearerToken != null && !bearerToken.trim().isEmpty();
                case API_KEY:
                    return apiKey != null && !apiKey.trim().isEmpty();
                case NONE:
                default:
                    return true; // No auth is valid
            }
        }
    }
    
    private final SharedPreferences preferences;
    
    public AgentRepository(Context context) {
        this.preferences = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }
    
    /**
     * Save agent configuration
     */
    public void saveAgentConfig(AgentConfig config) {
        SharedPreferences.Editor editor = preferences.edit();
        
        editor.putString(KEY_AGENT_URL, config.getAgentUrl());
        editor.putString(KEY_AUTH_TYPE, config.getAuthType().getValue());
        editor.putString(KEY_BEARER_TOKEN, config.getBearerToken());
        editor.putString(KEY_API_KEY, config.getApiKey());
        editor.putString(KEY_API_KEY_HEADER, config.getApiKeyHeader());
        editor.putString(KEY_SYSTEM_PROMPT, config.getSystemPrompt());
        editor.putBoolean(KEY_DEBUG, config.isDebug());
        
        editor.apply();
    }
    
    /**
     * Load agent configuration
     */
    public AgentConfig loadAgentConfig() {
        AgentConfig config = new AgentConfig();
        
        config.setAgentUrl(preferences.getString(KEY_AGENT_URL, ""));
        config.setAuthType(AuthType.fromValue(preferences.getString(KEY_AUTH_TYPE, "none")));
        config.setBearerToken(preferences.getString(KEY_BEARER_TOKEN, ""));
        config.setApiKey(preferences.getString(KEY_API_KEY, ""));
        config.setApiKeyHeader(preferences.getString(KEY_API_KEY_HEADER, "x-api-key"));
        config.setSystemPrompt(preferences.getString(KEY_SYSTEM_PROMPT, ""));
        config.setDebug(preferences.getBoolean(KEY_DEBUG, false));
        
        return config;
    }
    
    /**
     * Check if agent is configured
     */
    public boolean hasAgentConfig() {
        return loadAgentConfig().isValid();
    }
    
    /**
     * Clear all agent configuration
     */
    public void clearAgentConfig() {
        preferences.edit().clear().apply();
    }
}