package com.agui.chatapp.java.model;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.Objects;

/**
 * Represents a configured agent that the user can connect to.
 * This is a Java implementation of the AgentConfig from the compose app.
 */
public class AgentProfile {
    private final String id;
    private final String name;
    private final String url;
    private final String description;
    private final AuthMethod authMethod;
    private final boolean isActive;
    private final long createdAt;
    private final Long lastUsedAt;
    private final String systemPrompt;
    
    private AgentProfile(Builder builder) {
        this.id = builder.id;
        this.name = builder.name;
        this.url = builder.url;
        this.description = builder.description;
        this.authMethod = builder.authMethod;
        this.isActive = builder.isActive;
        this.createdAt = builder.createdAt;
        this.lastUsedAt = builder.lastUsedAt;
        this.systemPrompt = builder.systemPrompt;
    }
    
    @NonNull
    public String getId() {
        return id;
    }
    
    @NonNull
    public String getName() {
        return name;
    }
    
    @NonNull
    public String getUrl() {
        return url;
    }
    
    @Nullable
    public String getDescription() {
        return description;
    }
    
    @NonNull
    public AuthMethod getAuthMethod() {
        return authMethod;
    }
    
    public boolean isActive() {
        return isActive;
    }
    
    public long getCreatedAt() {
        return createdAt;
    }
    
    @Nullable
    public Long getLastUsedAt() {
        return lastUsedAt;
    }
    
    @Nullable
    public String getSystemPrompt() {
        return systemPrompt;
    }
    
    /**
     * Check if this agent profile is valid and can be used.
     */
    public boolean isValid() {
        return id != null && !id.trim().isEmpty() &&
               name != null && !name.trim().isEmpty() &&
               url != null && !url.trim().isEmpty() &&
               authMethod != null && authMethod.isValid();
    }
    
    /**
     * Create a copy of this profile with the specified active state.
     */
    public AgentProfile withActive(boolean active) {
        return toBuilder().setActive(active).build();
    }
    
    /**
     * Create a copy of this profile with the last used time updated.
     */
    public AgentProfile withLastUsedAt(long lastUsedAt) {
        return toBuilder().setLastUsedAt(lastUsedAt).build();
    }
    
    /**
     * Create a builder from this profile for easy copying/modification.
     */
    public Builder toBuilder() {
        return new Builder()
            .setId(id)
            .setName(name)
            .setUrl(url)
            .setDescription(description)
            .setAuthMethod(authMethod)
            .setActive(isActive)
            .setCreatedAt(createdAt)
            .setLastUsedAt(lastUsedAt)
            .setSystemPrompt(systemPrompt);
    }
    
    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (!(obj instanceof AgentProfile)) return false;
        AgentProfile that = (AgentProfile) obj;
        return isActive == that.isActive &&
               createdAt == that.createdAt &&
               Objects.equals(id, that.id) &&
               Objects.equals(name, that.name) &&
               Objects.equals(url, that.url) &&
               Objects.equals(description, that.description) &&
               Objects.equals(authMethod, that.authMethod) &&
               Objects.equals(lastUsedAt, that.lastUsedAt) &&
               Objects.equals(systemPrompt, that.systemPrompt);
    }
    
    @Override
    public int hashCode() {
        return Objects.hash(id, name, url, description, authMethod, isActive, createdAt, lastUsedAt, systemPrompt);
    }
    
    @Override
    public String toString() {
        return "AgentProfile{" +
                "id='" + id + '\'' +
                ", name='" + name + '\'' +
                ", url='" + url + '\'' +
                ", description='" + description + '\'' +
                ", authMethod=" + authMethod +
                ", isActive=" + isActive +
                ", createdAt=" + createdAt +
                ", lastUsedAt=" + lastUsedAt +
                ", systemPrompt='" + systemPrompt + '\'' +
                '}';
    }
    
    /**
     * Generate a unique ID for a new agent profile.
     */
    public static String generateId() {
        long timestamp = System.currentTimeMillis();
        int random = (int) (Math.random() * 9000) + 1000; // 4-digit random number
        return "agent_" + timestamp + "_" + random;
    }
    
    /**
     * Builder class for creating AgentProfile instances.
     */
    public static class Builder {
        private String id;
        private String name;
        private String url;
        private String description;
        private AuthMethod authMethod = new AuthMethod.None();
        private boolean isActive = false;
        private long createdAt = System.currentTimeMillis();
        private Long lastUsedAt;
        private String systemPrompt;
        
        public Builder() {}
        
        public Builder setId(@NonNull String id) {
            this.id = id;
            return this;
        }
        
        public Builder setName(@NonNull String name) {
            this.name = name;
            return this;
        }
        
        public Builder setUrl(@NonNull String url) {
            this.url = url;
            return this;
        }
        
        public Builder setDescription(@Nullable String description) {
            this.description = description;
            return this;
        }
        
        public Builder setAuthMethod(@NonNull AuthMethod authMethod) {
            this.authMethod = authMethod;
            return this;
        }
        
        public Builder setActive(boolean active) {
            this.isActive = active;
            return this;
        }
        
        public Builder setCreatedAt(long createdAt) {
            this.createdAt = createdAt;
            return this;
        }
        
        public Builder setLastUsedAt(@Nullable Long lastUsedAt) {
            this.lastUsedAt = lastUsedAt;
            return this;
        }
        
        public Builder setSystemPrompt(@Nullable String systemPrompt) {
            this.systemPrompt = systemPrompt;
            return this;
        }
        
        public AgentProfile build() {
            if (id == null) {
                id = generateId();
            }
            return new AgentProfile(this);
        }
    }
}