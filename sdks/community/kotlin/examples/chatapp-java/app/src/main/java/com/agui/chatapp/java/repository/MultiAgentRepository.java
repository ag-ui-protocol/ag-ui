package com.agui.chatapp.java.repository;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;

import com.agui.chatapp.java.model.AgentProfile;
import com.agui.chatapp.java.model.AuthMethod;
import com.agui.chatapp.java.model.ChatSession;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * Repository for managing multiple agent profiles with CRUD operations.
 * Uses simple key-value storage in SharedPreferences (no JSON dependencies).
 * Each agent is stored as separate preference entries.
 */
public class MultiAgentRepository {
    private static volatile MultiAgentRepository INSTANCE;
    private static final String PREFS_NAME = "multi_agent_repository";
    private static final String KEY_AGENT_LIST = "agent_list";
    private static final String KEY_ACTIVE_AGENT_ID = "active_agent_id";

    // Prefixes for agent properties
    private static final String PREFIX_AGENT = "agent_";
    private static final String SUFFIX_NAME = "_name";
    private static final String SUFFIX_URL = "_url";
    private static final String SUFFIX_DESCRIPTION = "_description";
    private static final String SUFFIX_AUTH_TYPE = "_auth_type";
    private static final String SUFFIX_AUTH_KEY = "_auth_key";
    private static final String SUFFIX_AUTH_HEADER = "_auth_header";
    private static final String SUFFIX_AUTH_TOKEN = "_auth_token";
    private static final String SUFFIX_AUTH_USERNAME = "_auth_username";
    private static final String SUFFIX_AUTH_PASSWORD = "_auth_password";
    private static final String SUFFIX_CREATED_AT = "_created_at";
    private static final String SUFFIX_LAST_USED_AT = "_last_used_at";
    private static final String SUFFIX_SYSTEM_PROMPT = "_system_prompt";

    private final SharedPreferences preferences;
    private final Executor executor;
    private final Handler mainThreadHandler = new Handler(Looper.getMainLooper());

    // LiveData for reactive updates
    private final MutableLiveData<List<AgentProfile>> agentsLiveData;
    private final MutableLiveData<AgentProfile> activeAgentLiveData;
    private final MutableLiveData<ChatSession> currentSessionLiveData;

    // In-memory cache
    private List<AgentProfile> agents;
    private AgentProfile activeAgent;
    private ChatSession currentSession;
    
    // Initialization tracking
    private final CompletableFuture<Void> initializationFuture = new CompletableFuture<>();

    // 2. Make the constructor private
    private MultiAgentRepository(@NonNull Context context) {
        this.preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.executor = Executors.newSingleThreadExecutor();

        this.agentsLiveData = new MutableLiveData<>();
        this.activeAgentLiveData = new MutableLiveData<>();
        this.currentSessionLiveData = new MutableLiveData<>();

        this.agents = new ArrayList<>();

        loadData();
    }
    public static MultiAgentRepository getInstance(@NonNull Context context) {
        if (INSTANCE == null) {
            synchronized (MultiAgentRepository.class) {
                if (INSTANCE == null) {
                    // Use application context to avoid memory leaks
                    INSTANCE = new MultiAgentRepository(context.getApplicationContext());
                }
            }
        }
        return INSTANCE;
    }

    /**
     * Get LiveData for observing the list of agents.
     */
    @NonNull
    public LiveData<List<AgentProfile>> getAgents() {
        return agentsLiveData;
    }

    /**
     * Get LiveData for observing the active agent.
     */
    @NonNull
    public LiveData<AgentProfile> getActiveAgent() {
        return activeAgentLiveData;
    }

    /**
     * Get LiveData for observing the current chat session.
     */
    @NonNull
    public LiveData<ChatSession> getCurrentSession() {
        return currentSessionLiveData;
    }

    /**
     * Add a new agent profile.
     */
    @NonNull
    public CompletableFuture<Void> addAgent(@NonNull AgentProfile agent) {
        return CompletableFuture.runAsync(() -> {
            synchronized (this) {
                List<AgentProfile> updatedAgents = new ArrayList<>(agents);
                updatedAgents.add(agent);
                agents = updatedAgents;
                saveAgent(agent);
                saveAgentList();
                agentsLiveData.postValue(new ArrayList<>(agents));
            }
        }, executor);
    }

    /**
     * Update an existing agent profile.
     */
    @NonNull
    public CompletableFuture<Void> updateAgent(@NonNull AgentProfile agent) {
        return CompletableFuture.runAsync(() -> {
            synchronized (this) {
                List<AgentProfile> updatedAgents = new ArrayList<>();
                boolean found = false;

                for (AgentProfile existing : agents) {
                    if (existing.getId().equals(agent.getId())) {
                        updatedAgents.add(agent);
                        found = true;
                    } else {
                        updatedAgents.add(existing);
                    }
                }

                if (found) {
                    agents = updatedAgents;
                    saveAgent(agent);
                    agentsLiveData.postValue(new ArrayList<>(agents));

                    // Update active agent if it's the one being updated
                    if (activeAgent != null && activeAgent.getId().equals(agent.getId())) {
                        activeAgent = agent;
                        activeAgentLiveData.postValue(activeAgent);
                    }
                }
            }
        }, executor);
    }

    /**
     * Delete an agent profile by ID.
     */
    @NonNull
    public CompletableFuture<Void> deleteAgent(@NonNull String agentId) {
        return CompletableFuture.runAsync(() -> {
            synchronized (this) {
                List<AgentProfile> updatedAgents = new ArrayList<>();
                boolean removed = false;

                for (AgentProfile agent : agents) {
                    if (!agent.getId().equals(agentId)) {
                        updatedAgents.add(agent);
                    } else {
                        removed = true;
                    }
                }

                if (removed) {
                    agents = updatedAgents;
                    deleteAgentFromStorage(agentId);
                    saveAgentList();
                    agentsLiveData.postValue(new ArrayList<>(agents));

                    // Clear active agent if it's the one being deleted
                    if (activeAgent != null && activeAgent.getId().equals(agentId)) {
                        setActiveAgentInternal(null);
                    }
                }
            }
        }, executor);
    }

    /**
     * Get an agent profile by ID.
     */
    @NonNull
    public CompletableFuture<AgentProfile> getAgent(@NonNull String agentId) {
        return CompletableFuture.supplyAsync(() -> {
            synchronized (this) {
                for (AgentProfile agent : agents) {
                    if (agent.getId().equals(agentId)) {
                        return agent;
                    }
                }
                throw new IllegalArgumentException("Agent not found: " + agentId);
            }
        }, executor);
    }

    /**
     * Set the active agent and start a new chat session.
     */
    @NonNull
    public CompletableFuture<Void> setActiveAgent(@Nullable AgentProfile agent) {
        return CompletableFuture.runAsync(() -> {
            synchronized (this) {
                setActiveAgentInternal(agent);
            }
        }, executor);
    }

    /**
     * Get current active agent synchronously (for immediate access).
     */
    @Nullable
    public AgentProfile getCurrentActiveAgent() {
        synchronized (this) {
            return activeAgent;
        }
    }

    /**
     * Get current session synchronously (for immediate access).
     */
    @Nullable
    public ChatSession getCurrentChatSession() {
        synchronized (this) {
            return currentSession;
        }
    }

    /**
     * Clear all data (useful for testing).
     */
    @NonNull
    public CompletableFuture<Void> clearAll() {
        return CompletableFuture.runAsync(() -> {
            synchronized (this) {
                agents.clear();
                activeAgent = null;
                currentSession = null;

                preferences.edit()
                        .remove(KEY_AGENT_LIST)
                        .remove(KEY_ACTIVE_AGENT_ID)
                        .apply();

                agentsLiveData.postValue(new ArrayList<>());
                activeAgentLiveData.postValue(null);
                currentSessionLiveData.postValue(null);
            }
        }, executor);
    }

    private void setActiveAgentInternal(@Nullable AgentProfile agent) {
        android.util.Log.d("MultiAgentRepo", "=== SET ACTIVE AGENT INTERNAL ===");
        android.util.Log.d("MultiAgentRepo", "Previous active agent: " + (activeAgent != null ? activeAgent.getName() + " (ID: " + activeAgent.getId() + ")" : "null"));
        android.util.Log.d("MultiAgentRepo", "New agent: " + (agent != null ? agent.getName() + " (ID: " + agent.getId() + ")" : "null"));

        activeAgent = agent;

        if (agent != null) {
            // Update last used time
            AgentProfile updatedAgent = agent.withLastUsedAt(System.currentTimeMillis());
            updateAgentInList(updatedAgent);
            activeAgent = updatedAgent;

            // Start a new session
            String newThreadId = ChatSession.generateThreadId();
            currentSession = new ChatSession(agent.getId(), newThreadId);
            android.util.Log.d("MultiAgentRepo", "Created new session with thread ID: " + newThreadId);

            // Persist the active agent's ID
            preferences.edit()
                    .putString(KEY_ACTIVE_AGENT_ID, agent.getId())
                    .apply();
        } else {
            currentSession = null;
            preferences.edit()
                    .remove(KEY_ACTIVE_AGENT_ID)
                    .apply();
        }

        // Directly post the final values to LiveData
        activeAgentLiveData.postValue(activeAgent);
        currentSessionLiveData.postValue(currentSession);
    }
    private void updateAgentInList(@NonNull AgentProfile updatedAgent) {
        for (int i = 0; i < agents.size(); i++) {
            if (agents.get(i).getId().equals(updatedAgent.getId())) {
                agents.set(i, updatedAgent);
                saveAgent(updatedAgent);
                agentsLiveData.postValue(new ArrayList<>(agents));
                break;
            }
        }
    }

    private void loadData() {
        executor.execute(() -> {
            synchronized (this) {
                // Load agent list
                agents = loadAllAgents();

                // Load active agent
                String activeAgentId = preferences.getString(KEY_ACTIVE_AGENT_ID, null);
                if (activeAgentId != null) {
                    for (AgentProfile agent : agents) {
                        if (agent.getId().equals(activeAgentId)) {
                            activeAgent = agent;
                            currentSession = new ChatSession(agent.getId(), ChatSession.generateThreadId());
                            break;
                        }
                    }
                }

                // Post initial values
                agentsLiveData.postValue(new ArrayList<>(agents));
                activeAgentLiveData.postValue(activeAgent);
                currentSessionLiveData.postValue(currentSession);
                
                // Mark initialization as complete
                initializationFuture.complete(null);
            }
        });
    }
    
    /**
     * Wait for the repository to finish loading initial data.
     * Useful for tests to ensure data is loaded.
     */
    public CompletableFuture<Void> waitForInitialization() {
        return initializationFuture;
    }

    private List<AgentProfile> loadAllAgents() {
        String agentListString = preferences.getString(KEY_AGENT_LIST, "");
        if (agentListString.isEmpty()) {
            return new ArrayList<>();
        }

        String[] agentIds = agentListString.split(",");
        List<AgentProfile> loadedAgents = new ArrayList<>();

        for (String agentId : agentIds) {
            AgentProfile agent = loadAgent(agentId.trim());
            if (agent != null) {
                loadedAgents.add(agent);
            }
        }

        return loadedAgents;
    }

    private AgentProfile loadAgent(String agentId) {
        String nameKey = PREFIX_AGENT + agentId + SUFFIX_NAME;
        String name = preferences.getString(nameKey, null);
        if (name == null) {
            return null; // Agent doesn't exist
        }

        String url = preferences.getString(PREFIX_AGENT + agentId + SUFFIX_URL, "");
        String description = preferences.getString(PREFIX_AGENT + agentId + SUFFIX_DESCRIPTION, null);
        String authType = preferences.getString(PREFIX_AGENT + agentId + SUFFIX_AUTH_TYPE, "none");
        long createdAt = preferences.getLong(PREFIX_AGENT + agentId + SUFFIX_CREATED_AT, System.currentTimeMillis());
        long lastUsedAtLong = preferences.getLong(PREFIX_AGENT + agentId + SUFFIX_LAST_USED_AT, -1);
        Long lastUsedAt = lastUsedAtLong == -1 ? null : lastUsedAtLong;
        String systemPrompt = preferences.getString(PREFIX_AGENT + agentId + SUFFIX_SYSTEM_PROMPT, null);

        // Load auth method based on type
        AuthMethod authMethod = loadAuthMethod(agentId, authType);

        return new AgentProfile.Builder()
                .setId(agentId)
                .setName(name)
                .setUrl(url)
                .setDescription(description)
                .setAuthMethod(authMethod)
                .setCreatedAt(createdAt)
                .setLastUsedAt(lastUsedAt)
                .setSystemPrompt(systemPrompt)
                .build();
    }

    private AuthMethod loadAuthMethod(String agentId, String authType) {
        switch (authType) {
            case "none":
                return new AuthMethod.None();
            case "api_key":
                String key = preferences.getString(PREFIX_AGENT + agentId + SUFFIX_AUTH_KEY, "");
                String header = preferences.getString(PREFIX_AGENT + agentId + SUFFIX_AUTH_HEADER, "X-API-Key");
                return new AuthMethod.ApiKey(key, header);
            case "bearer_token":
                String token = preferences.getString(PREFIX_AGENT + agentId + SUFFIX_AUTH_TOKEN, "");
                return new AuthMethod.BearerToken(token);
            case "basic_auth":
                String username = preferences.getString(PREFIX_AGENT + agentId + SUFFIX_AUTH_USERNAME, "");
                String password = preferences.getString(PREFIX_AGENT + agentId + SUFFIX_AUTH_PASSWORD, "");
                return new AuthMethod.BasicAuth(username, password);
            default:
                return new AuthMethod.None();
        }
    }

    private void saveAgent(AgentProfile agent) {
        SharedPreferences.Editor editor = preferences.edit();
        String agentId = agent.getId();

        // Save basic properties
        editor.putString(PREFIX_AGENT + agentId + SUFFIX_NAME, agent.getName());
        editor.putString(PREFIX_AGENT + agentId + SUFFIX_URL, agent.getUrl());
        if (agent.getDescription() != null) {
            editor.putString(PREFIX_AGENT + agentId + SUFFIX_DESCRIPTION, agent.getDescription());
        }
        editor.putLong(PREFIX_AGENT + agentId + SUFFIX_CREATED_AT, agent.getCreatedAt());
        if (agent.getLastUsedAt() != null) {
            editor.putLong(PREFIX_AGENT + agentId + SUFFIX_LAST_USED_AT, agent.getLastUsedAt());
        }
        if (agent.getSystemPrompt() != null) {
            editor.putString(PREFIX_AGENT + agentId + SUFFIX_SYSTEM_PROMPT, agent.getSystemPrompt());
        }

        // Save auth method
        AuthMethod authMethod = agent.getAuthMethod();
        editor.putString(PREFIX_AGENT + agentId + SUFFIX_AUTH_TYPE, authMethod.getType());

        if (authMethod instanceof AuthMethod.ApiKey) {
            AuthMethod.ApiKey apiKey = (AuthMethod.ApiKey) authMethod;
            editor.putString(PREFIX_AGENT + agentId + SUFFIX_AUTH_KEY, apiKey.getKey());
            editor.putString(PREFIX_AGENT + agentId + SUFFIX_AUTH_HEADER, apiKey.getHeaderName());
        } else if (authMethod instanceof AuthMethod.BearerToken) {
            AuthMethod.BearerToken bearerToken = (AuthMethod.BearerToken) authMethod;
            editor.putString(PREFIX_AGENT + agentId + SUFFIX_AUTH_TOKEN, bearerToken.getToken());
        } else if (authMethod instanceof AuthMethod.BasicAuth) {
            AuthMethod.BasicAuth basicAuth = (AuthMethod.BasicAuth) authMethod;
            editor.putString(PREFIX_AGENT + agentId + SUFFIX_AUTH_USERNAME, basicAuth.getUsername());
            editor.putString(PREFIX_AGENT + agentId + SUFFIX_AUTH_PASSWORD, basicAuth.getPassword());
        }

        editor.apply();
    }

    private void saveAgentList() {
        List<String> agentIds = new ArrayList<>();
        for (AgentProfile agent : agents) {
            agentIds.add(agent.getId());
        }
        String agentListString = String.join(",", agentIds);
        preferences.edit()
                .putString(KEY_AGENT_LIST, agentListString)
                .apply();
    }

    private void deleteAgentFromStorage(String agentId) {
        SharedPreferences.Editor editor = preferences.edit();

        // Remove all agent properties
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_NAME);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_URL);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_DESCRIPTION);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_AUTH_TYPE);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_AUTH_KEY);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_AUTH_HEADER);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_AUTH_TOKEN);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_AUTH_USERNAME);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_AUTH_PASSWORD);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_CREATED_AT);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_LAST_USED_AT);
        editor.remove(PREFIX_AGENT + agentId + SUFFIX_SYSTEM_PROMPT);

        editor.apply();
    }

}