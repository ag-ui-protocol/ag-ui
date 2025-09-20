package com.agui.chatapp.java.viewmodel;

import android.app.Application;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.lifecycle.AndroidViewModel;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;

import com.agui.chatapp.java.adapter.AgUiAgentBuilder;
import com.agui.chatapp.java.adapter.AgUiJavaAdapter;
import com.agui.chatapp.java.adapter.EventCallback;
import com.agui.chatapp.java.adapter.EventProcessor;
import com.agui.chatapp.java.model.AgentProfile;
import com.agui.chatapp.java.model.AuthMethod;
import com.agui.chatapp.java.model.ChatMessage;
import com.agui.chatapp.java.repository.MultiAgentRepository;
import com.agui.core.types.*;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import io.reactivex.rxjava3.disposables.CompositeDisposable;
import io.reactivex.rxjava3.disposables.Disposable;

/**
 * ViewModel for the chat screen using Android Architecture Components.
 * Manages chat state, message history, and agent communication.
 */
public class ChatViewModel extends AndroidViewModel {
    private static final String TAG = "ChatViewModel";

    private final MultiAgentRepository repository;
    private final CompositeDisposable disposables = new CompositeDisposable();

    // LiveData for UI state
    private final MutableLiveData<List<ChatMessage>> messages = new MutableLiveData<>(new ArrayList<>());
    private final MutableLiveData<Boolean> isConnecting = new MutableLiveData<>(false);
    private final MutableLiveData<String> errorMessage = new MutableLiveData<>();
    private final MutableLiveData<Boolean> hasAgentConfig = new MutableLiveData<>(false);

    // Current active agent
    private AgentProfile currentAgent;

    // Agent and adapter
    private AgUiJavaAdapter agentAdapter;

    // Thread ID management
    private String currentThreadId;

    // Message tracking for streaming
    private final Map<String, ChatMessage> streamingMessages = new HashMap<>();

    public ChatViewModel(@NonNull Application application) {
        super(application);
        // Use the getInstance() method
        this.repository = MultiAgentRepository.getInstance(application);
        this.currentThreadId = generateNewThreadId();
    }

    // LiveData getters
    public LiveData<List<ChatMessage>> getMessages() {
        return messages;
    }

    public LiveData<Boolean> getIsConnecting() {
        return isConnecting;
    }

    public LiveData<String> getErrorMessage() {
        return errorMessage;
    }

    public LiveData<Boolean> getHasAgentConfig() {
        return hasAgentConfig;
    }

    public LiveData<AgentProfile> getActiveAgent() {
        return repository.getActiveAgent();
    }

    /**
     * Handle active agent changes
     * This is called whenever an agent is activated from the Settings screen
     */
    public void setActiveAgent(AgentProfile agent) {
        // Log for debugging
        String currentAgentId = currentAgent != null ? currentAgent.getId() : "null";
        String newAgentId = agent != null ? agent.getId() : "null";

        // Only proceed if the agent has actually changed
        if ((currentAgentId == null && newAgentId == null) || 
            (currentAgentId != null && currentAgentId.equals(newAgentId))) {
            return;
        }


        // Clean up existing agent if any
        if (agentAdapter != null) {
            agentAdapter.close();
            agentAdapter = null;
        }

        // Always clear messages for a fresh start
        messages.setValue(new ArrayList<>());
        streamingMessages.clear();

        // Always generate new thread ID for fresh conversation
        currentThreadId = generateNewThreadId();

        // Update current agent reference
        currentAgent = agent;

        if (currentAgent != null) {
            initializeAgent();
        } else {
            // Handle the case where there is no active agent
            hasAgentConfig.setValue(false);
        }
    }

    /**
     * Initialize the agent with current active agent profile
     */
    private void initializeAgent() {
        if (currentAgent == null) {
            hasAgentConfig.setValue(false);
            return;
        }

        Log.d(TAG, "Initializing agent: " + currentAgent.getName() + " with URL: " + currentAgent.getUrl());

        try {
            AgUiAgentBuilder builder = AgUiAgentBuilder.create(currentAgent.getUrl())
                    .debug(false); // Debug can be made configurable later

            // Add authentication based on agent profile
            AuthMethod authMethod = currentAgent.getAuthMethod();
            Log.d(TAG, "Auth method: " + authMethod.getClass().getSimpleName());

            if (authMethod instanceof AuthMethod.BearerToken) {
                AuthMethod.BearerToken bearerToken = (AuthMethod.BearerToken) authMethod;
                builder.bearerToken(bearerToken.getToken());
                Log.d(TAG, "Using Bearer Token auth");
            } else if (authMethod instanceof AuthMethod.ApiKey) {
                AuthMethod.ApiKey apiKey = (AuthMethod.ApiKey) authMethod;
                builder.apiKey(apiKey.getKey())
                        .apiKeyHeader(apiKey.getHeaderName());
                Log.d(TAG, "Using API Key auth with header: " + apiKey.getHeaderName());
            } else if (authMethod instanceof AuthMethod.BasicAuth) {
                AuthMethod.BasicAuth basicAuth = (AuthMethod.BasicAuth) authMethod;
                // Basic auth needs to be Base64 encoded and added as Authorization header
                String credentials = basicAuth.getUsername() + ":" + basicAuth.getPassword();
                String encodedCredentials = android.util.Base64.encodeToString(
                        credentials.getBytes(), android.util.Base64.NO_WRAP);
                builder.addHeader("Authorization", "Basic " + encodedCredentials);
                Log.d(TAG, "Using Basic Auth with username: " + basicAuth.getUsername());
            } else {
                Log.d(TAG, "No authentication configured");
            }

            // Add system prompt
            if (currentAgent.getSystemPrompt() != null && !currentAgent.getSystemPrompt().trim().isEmpty()) {
                builder.systemPrompt(currentAgent.getSystemPrompt());
                Log.d(TAG, "System prompt configured: " + currentAgent.getSystemPrompt().substring(0, Math.min(50, currentAgent.getSystemPrompt().length())) + "...");
            } else {
                Log.d(TAG, "No system prompt configured");
            }

            agentAdapter = new AgUiJavaAdapter(builder.buildStateful());
            hasAgentConfig.setValue(true);
            Log.d(TAG, "Agent initialized successfully: " + currentAgent.getName());

        } catch (Exception e) {
            Log.e(TAG, "Failed to initialize agent", e);
            errorMessage.setValue("Failed to initialize agent: " + e.getMessage());
            hasAgentConfig.setValue(false);
        }
    }

    /**
     * Send a message to the agent
     */
    public void sendMessage(String messageText) {
        if (agentAdapter == null) {
            Log.e(TAG, "Agent adapter is null - cannot send message");
            errorMessage.setValue("Agent not configured");
            return;
        }

        if (messageText == null || messageText.trim().isEmpty()) {
            return;
        }

        String threadIdBeingSent = getCurrentThreadId();

        // Add user message to chat
        ChatMessage userMessage = new ChatMessage(
                "user_" + System.currentTimeMillis(),
                Role.USER,
                messageText.trim(),
                null
        );
        addMessage(userMessage);

        // Start connecting
        isConnecting.setValue(true);

        // Send message to agent with current thread ID
        Disposable disposable = agentAdapter.sendMessage(messageText.trim(), threadIdBeingSent, new EventCallback() {
            @Override
            public void onEvent(BaseEvent event) {
                handleAgentEvent(event);
            }

            @Override
            public void onError(Throwable error) {
                Log.e(TAG, "Agent error", error);
                isConnecting.setValue(false);
                errorMessage.setValue("Connection error: " + error.getMessage());
            }

            @Override
            public void onComplete() {
                Log.d(TAG, "Agent response complete");
                isConnecting.setValue(false);

                // Finish any remaining streaming messages by replacing them
                if (!streamingMessages.isEmpty()) {
                    List<ChatMessage> currentMessages = messages.getValue();
                    if (currentMessages != null) {
                        List<ChatMessage> newMessages = new ArrayList<>(currentMessages);

                        for (ChatMessage streamingMessage : streamingMessages.values()) {
                            // Create finished message
                            ChatMessage finishedMessage = new ChatMessage(
                                    streamingMessage.getId(),
                                    streamingMessage.getRole(),
                                    streamingMessage.getContent(),
                                    streamingMessage.getName()
                            );

                            // Replace in list
                            int index = newMessages.indexOf(streamingMessage);
                            if (index >= 0) {
                                newMessages.set(index, finishedMessage);
                            }
                        }

                        messages.setValue(newMessages);
                    }

                    streamingMessages.clear();
                }
            }
        });

        disposables.add(disposable);
    }

    /**
     * Handle events from the agent
     */
    private void handleAgentEvent(BaseEvent event) {
        EventProcessor.processEvent(event, new EventProcessor.EventHandler() {
            @Override
            public void onRunStarted(RunStartedEvent event) {
                Log.d(TAG, "Run started: " + event.getRunId());
            }

            @Override
            public void onRunFinished(RunFinishedEvent event) {
                Log.d(TAG, "Run finished: " + event.getRunId());
                isConnecting.setValue(false);
            }

            @Override
            public void onRunError(RunErrorEvent event) {
                Log.e(TAG, "Run error: " + event.getMessage());
                isConnecting.setValue(false);
                errorMessage.setValue("Agent error: " + event.getMessage());
            }

            @Override
            public void onStepStarted(StepStartedEvent event) {
                Log.d(TAG, "Step started: " + event.getStepName());
            }

            @Override
            public void onStepFinished(StepFinishedEvent event) {
                Log.d(TAG, "Step finished: " + event.getStepName());
            }

            @Override
            public void onTextMessageStart(TextMessageStartEvent event) {
                Log.d(TAG, "Text message start: " + event.getMessageId());

                // Create streaming message
                ChatMessage streamingMessage = ChatMessage.createStreaming(
                        event.getMessageId(),
                        Role.ASSISTANT,
                        null
                );

                streamingMessages.put(event.getMessageId(), streamingMessage);
                addMessage(streamingMessage);
            }

            @Override
            public void onTextMessageContent(TextMessageContentEvent event) {
                Log.d(TAG, "Text message content: " + event.getDelta());

                // Update streaming message
                ChatMessage message = streamingMessages.get(event.getMessageId());
                if (message != null) {
                    message.appendStreamingContent(event.getDelta());
                    notifyMessagesChanged();
                }
            }

            @Override
            public void onTextMessageEnd(TextMessageEndEvent event) {
                Log.d(TAG, "Text message end: " + event.getMessageId());

                // Finish streaming message by creating a new instance
                ChatMessage streamingMessage = streamingMessages.get(event.getMessageId());
                if (streamingMessage != null) {
                    // Create a new non-streaming message with the final content
                    ChatMessage finishedMessage = new ChatMessage(
                            streamingMessage.getId(),
                            streamingMessage.getRole(),
                            streamingMessage.getContent(), // This gets the streamed content
                            streamingMessage.getName()
                    );

                    // Replace the streaming message with the finished one
                    List<ChatMessage> currentMessages = messages.getValue();
                    if (currentMessages != null) {
                        List<ChatMessage> newMessages = new ArrayList<>(currentMessages);
                        int index = newMessages.indexOf(streamingMessage);
                        if (index >= 0) {
                            newMessages.set(index, finishedMessage);
                            messages.setValue(newMessages);
                        }
                    }

                    streamingMessages.remove(event.getMessageId());
                }
            }

            @Override
            public void onToolCallStart(ToolCallStartEvent event) {
                Log.d(TAG, "Tool call start: " + event.getToolCallId());
            }

            @Override
            public void onToolCallArgs(ToolCallArgsEvent event) {
                Log.d(TAG, "Tool call args: " + event.getDelta());
            }

            @Override
            public void onToolCallEnd(ToolCallEndEvent event) {
                Log.d(TAG, "Tool call end: " + event.getToolCallId());
            }

            @Override
            public void onStateSnapshot(StateSnapshotEvent event) {
                Log.d(TAG, "State snapshot received");
            }

            @Override
            public void onStateDelta(StateDeltaEvent event) {
                Log.d(TAG, "State delta received");
            }

            @Override
            public void onMessagesSnapshot(MessagesSnapshotEvent event) {
                Log.d(TAG, "Messages snapshot received");
            }

            @Override
            public void onRawEvent(RawEvent event) {
                Log.d(TAG, "Raw event: " + event.getEvent());
            }

            @Override
            public void onCustomEvent(CustomEvent event) {
                Log.d(TAG, "Custom event: " + event.getValue());
            }

            @Override
            public void onUnknownEvent(BaseEvent event) {
                Log.w(TAG, "Unknown event type: " + event.getClass().getSimpleName());
            }
        });
    }

    /**
     * Test connection to the agent
     */
    public CompletableFuture<Boolean> testConnection() {
        if (agentAdapter == null) {
            return CompletableFuture.completedFuture(false);
        }

        return agentAdapter.testConnection();
    }

    /**
     * Clear chat history
     */
    public void clearHistory() {
        if (agentAdapter != null) {
            agentAdapter.clearHistory();
        }

        // Generate new thread ID for fresh conversation
        currentThreadId = generateNewThreadId();

        messages.setValue(new ArrayList<>());
        streamingMessages.clear();
    }


    /**
     * Refresh agent configuration (call after settings change)
     */
    public void refreshAgentConfiguration() {
        // Clean up existing agent
        if (agentAdapter != null) {
            agentAdapter.close();
            agentAdapter = null;
        }

        // Reinitialize with current agent (preserve thread ID for conversation continuity)
        if (currentAgent != null) {
            initializeAgent();
        }
    }


    /**
     * Add a message to the chat
     */
    private void addMessage(ChatMessage message) {
        List<ChatMessage> currentMessages = messages.getValue();
        if (currentMessages != null) {
            List<ChatMessage> newMessages = new ArrayList<>(currentMessages);
            newMessages.add(message);
            messages.setValue(newMessages);
        }
    }

    /**
     * Notify that messages have changed (for streaming updates)
     */
    private void notifyMessagesChanged() {
        List<ChatMessage> currentMessages = messages.getValue();
        if (currentMessages != null) {
            messages.setValue(new ArrayList<>(currentMessages));
        }
    }

    /**
     * Generate a new unique thread ID
     */
    private String generateNewThreadId() {
        return "thread_" + System.currentTimeMillis() + "_" + (int)(Math.random() * 1000);
    }

    /**
     * Get the current thread ID, creating one if needed
     */
    private String getCurrentThreadId() {
        if (currentThreadId == null) {
            currentThreadId = generateNewThreadId();
        }
        return currentThreadId;
    }

    @Override
    protected void onCleared() {
        super.onCleared();

        // Clean up disposables
        disposables.clear();

        // Clean up agent
        if (agentAdapter != null) {
            agentAdapter.close();
        }
    }
}