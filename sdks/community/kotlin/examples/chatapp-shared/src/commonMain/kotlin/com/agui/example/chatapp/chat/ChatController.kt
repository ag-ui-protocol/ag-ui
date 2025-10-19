package com.agui.example.chatapp.chat

import co.touchlab.kermit.Logger
import com.agui.core.types.BaseEvent
import com.agui.core.types.RunErrorEvent
import com.agui.core.types.RunFinishedEvent
import com.agui.core.types.StateDeltaEvent
import com.agui.core.types.StateSnapshotEvent
import com.agui.core.types.StepFinishedEvent
import com.agui.core.types.StepStartedEvent
import com.agui.core.types.TextMessageContentEvent
import com.agui.core.types.TextMessageEndEvent
import com.agui.core.types.TextMessageStartEvent
import com.agui.core.types.ToolCallArgsEvent
import com.agui.core.types.ToolCallEndEvent
import com.agui.core.types.ToolCallStartEvent
import com.agui.example.chatapp.data.auth.AuthManager
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.util.Strings
import com.agui.example.chatapp.util.UserIdManager
import com.agui.example.chatapp.util.getPlatformSettings
import com.agui.example.tools.BackgroundChangeHandler
import com.agui.example.tools.BackgroundStyle
import com.agui.example.tools.ChangeBackgroundToolExecutor
import com.agui.tools.DefaultToolRegistry
import kotlinx.atomicfu.atomic
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.datetime.Clock
import com.russhwolf.settings.Settings

private val logger = Logger.withTag("ChatController")

/**
 * Shared chat coordinator that exposes AG-UI conversation flows to multiplatform UIs.
 * The controller is platform agnostic and owns the underlying Kotlin SDK client state.
 */
class ChatController(
    externalScope: CoroutineScope? = null,
    private val agentFactory: ChatAgentFactory = ChatAgentFactory.default(),
    private val settings: Settings = getPlatformSettings(),
    private val agentRepository: AgentRepository = AgentRepository.getInstance(settings),
    private val authManager: AuthManager = AuthManager(),
    private val userIdManager: UserIdManager = UserIdManager.getInstance(settings)
) {

    private val scope = externalScope ?: MainScope()
    private val ownsScope = externalScope == null

    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()

    private var currentAgent: ChatAgent? = null
    private var currentJob: Job? = null
    private var currentThreadId: String? = null

    private val streamingMessages = mutableMapOf<String, StringBuilder>()
    private val toolCallBuffer = mutableMapOf<String, StringBuilder>()
    private val pendingToolCalls = mutableMapOf<String, String>() // toolCallId -> toolName
    private val ephemeralMessageIds = mutableMapOf<EphemeralType, String>()

    private val controllerClosed = atomic(false)

    init {
        scope.launch {
            agentRepository.activeAgent.collectLatest { agent ->
                _state.update { it.copy(activeAgent = agent) }
                if (agent != null) {
                    connectToAgent(agent)
                } else {
                    disconnectFromAgent()
                }
            }
        }
    }

    private suspend fun connectToAgent(agentConfig: AgentConfig) {
        disconnectFromAgent()

        try {
            val headers = agentConfig.customHeaders.toMutableMap()
            authManager.applyAuth(agentConfig.authMethod, headers)

            val backgroundTool = ChangeBackgroundToolExecutor(object : BackgroundChangeHandler {
                override suspend fun applyBackground(style: BackgroundStyle) {
                    _state.update { it.copy(background = style) }
                }
            })

            val clientToolRegistry = DefaultToolRegistry().apply {
                registerTool(backgroundTool)
            }

            currentAgent = agentFactory.createAgent(
                config = agentConfig,
                headers = headers,
                toolRegistry = clientToolRegistry,
                userId = userIdManager.getUserId(),
                systemPrompt = agentConfig.systemPrompt
            )

            currentThreadId = "thread_${Clock.System.now().toEpochMilliseconds()}"

            _state.update { it.copy(isConnected = true, error = null, background = BackgroundStyle.Default) }

            addDisplayMessage(
                DisplayMessage(
                    id = generateMessageId(),
                    role = MessageRole.SYSTEM,
                    content = "${Strings.CONNECTED_TO_PREFIX}${agentConfig.name}"
                )
            )
        } catch (e: Exception) {
            logger.e(e) { "Failed to connect to agent" }
            _state.update {
                it.copy(
                    isConnected = false,
                    error = "${Strings.FAILED_TO_CONNECT_PREFIX}${e.message}"
                )
            }
        }
    }

    private fun disconnectFromAgent() {
        currentJob?.cancel()
        currentJob = null
        currentAgent = null
        currentThreadId = null
        streamingMessages.clear()
        toolCallBuffer.clear()
        pendingToolCalls.clear()
        ephemeralMessageIds.clear()

        _state.update {
            it.copy(
                isConnected = false,
                messages = emptyList(),
                background = BackgroundStyle.Default
            )
        }
    }

    fun sendMessage(content: String) {
        if (content.isBlank() || currentAgent == null || controllerClosed.value) return

        addDisplayMessage(
            DisplayMessage(
                id = generateMessageId(),
                role = MessageRole.USER,
                content = content.trim()
            )
        )

        startConversation(content.trim())
    }

    private fun startConversation(content: String) {
        currentJob?.cancel()

        currentJob = scope.launch {
            _state.update { it.copy(isLoading = true) }

            try {
                currentAgent?.sendMessage(
                    message = content,
                    threadId = currentThreadId ?: "default"
                )?.collect { event ->
                    handleAgentEvent(event)
                }
            } catch (e: Exception) {
                logger.e(e) { "Error running agent" }
                addDisplayMessage(
                    DisplayMessage(
                        id = generateMessageId(),
                        role = MessageRole.ERROR,
                        content = "${Strings.ERROR_PREFIX}${e.message}"
                    )
                )
            } finally {
                _state.update { it.copy(isLoading = false) }
                finalizeStreamingMessages()
                ephemeralMessageIds.keys.toList().forEach { type ->
                    clearEphemeralMessage(type)
                }
            }
        }
    }

    internal fun handleAgentEvent(event: BaseEvent) {
        logger.d { "Handling event: ${event::class.simpleName}" }

        when (event) {
            is ToolCallStartEvent -> {
                toolCallBuffer[event.toolCallId] = StringBuilder()
                pendingToolCalls[event.toolCallId] = event.toolCallName

                if (event.toolCallName != "change_background") {
                    setEphemeralMessage(
                        content = "Calling ${event.toolCallName}...",
                        type = EphemeralType.TOOL_CALL,
                        icon = "🔧"
                    )
                }
            }

            is ToolCallArgsEvent -> {
                toolCallBuffer[event.toolCallId]?.append(event.delta)
                val currentArgs = toolCallBuffer[event.toolCallId]?.toString() ?: ""

                val toolName = pendingToolCalls[event.toolCallId]
                if (toolName != "change_background") {
                    setEphemeralMessage(
                        content = "Calling tool with: ${currentArgs.take(50)}${if (currentArgs.length > 50) "..." else ""}",
                        type = EphemeralType.TOOL_CALL,
                        icon = "🔧"
                    )
                }
            }

            is ToolCallEndEvent -> {
                val toolName = pendingToolCalls[event.toolCallId]

                if (toolName != "change_background") {
                    scope.launch {
                        delay(1000)
                        clearEphemeralMessage(EphemeralType.TOOL_CALL)
                    }
                }

                logger.i {
                    "ToolCallEnd id=${event.toolCallId} name=${toolName ?: "<unknown>"}"
                }
                toolCallBuffer.remove(event.toolCallId)
                pendingToolCalls.remove(event.toolCallId)
            }

            is StepStartedEvent -> {
                setEphemeralMessage(
                    content = event.stepName,
                    type = EphemeralType.STEP,
                    icon = "●"
                )
            }

            is StepFinishedEvent -> {
                scope.launch {
                    delay(500)
                    clearEphemeralMessage(EphemeralType.STEP)
                }
            }

            is TextMessageStartEvent -> {
                logger.i { "TextMessageStart id=${event.messageId}" }
                streamingMessages[event.messageId] = StringBuilder()
                addDisplayMessage(
                    DisplayMessage(
                        id = event.messageId,
                        role = MessageRole.ASSISTANT,
                        content = "",
                        isStreaming = true
                    )
                )
            }

            is TextMessageContentEvent -> {
                logger.i {
                    val deltaPreview = event.delta.replace('\n', ' ')
                    "TextMessageContent id=${event.messageId} delta='" + deltaPreview.take(80) + if (deltaPreview.length > 80) "…" else "'"
                }
                streamingMessages[event.messageId]?.append(event.delta)
                updateStreamingMessage(event.messageId, event.delta)
            }

            is TextMessageEndEvent -> {
                val complete = streamingMessages[event.messageId]?.toString()
                logger.i {
                    "TextMessageEnd id=${event.messageId} text='" + summarizeForLog(complete) + "'"
                }
                finalizeStreamingMessage(event.messageId)
            }

            is RunErrorEvent -> {
                addDisplayMessage(
                    DisplayMessage(
                        id = generateMessageId(),
                        role = MessageRole.ERROR,
                        content = "${Strings.AGENT_ERROR_PREFIX}${event.message}"
                    )
                )
            }

            is RunFinishedEvent -> {
                ephemeralMessageIds.keys.toList().forEach { type ->
                    clearEphemeralMessage(type)
                }
            }

            is StateDeltaEvent, is StateSnapshotEvent -> Unit
            else -> logger.d { "Received event: $event" }
        }
    }

    fun cancelCurrentOperation() {
        currentJob?.cancel()

        _state.update { it.copy(isLoading = false) }
        finalizeStreamingMessages()
        ephemeralMessageIds.keys.toList().forEach { type ->
            clearEphemeralMessage(type)
        }
    }

    fun clearError() {
        _state.update { it.copy(error = null) }
    }

    fun close() {
        if (!controllerClosed.compareAndSet(expect = false, update = true)) return

        cancelCurrentOperation()
        disconnectFromAgent()
        if (ownsScope) {
            scope.cancel()
        }
    }

    private fun setEphemeralMessage(content: String, type: EphemeralType, icon: String = "") {
        _state.update { state ->
            val oldId = ephemeralMessageIds[type]
            val filtered = if (oldId != null) {
                state.messages.filter { it.id != oldId }
            } else {
                state.messages
            }

            val newMessage = DisplayMessage(
                id = generateMessageId(),
                role = when (type) {
                    EphemeralType.TOOL_CALL -> MessageRole.TOOL_CALL
                    EphemeralType.STEP -> MessageRole.STEP_INFO
                },
                content = "$icon $content".trim(),
                ephemeralGroupId = type.name,
                ephemeralType = type
            )

            ephemeralMessageIds[type] = newMessage.id

            state.copy(messages = filtered + newMessage)
        }
    }

    private fun clearEphemeralMessage(type: EphemeralType) {
        val messageId = ephemeralMessageIds[type]
        if (messageId != null) {
            _state.update { state ->
                state.copy(messages = state.messages.filter { it.id != messageId })
            }
            ephemeralMessageIds.remove(type)
        }
    }

    private fun updateStreamingMessage(messageId: String, delta: String) {
        _state.update { state ->
            state.copy(
                messages = state.messages.map { msg ->
                    if (msg.id == messageId) {
                        msg.copy(content = msg.content + delta)
                    } else {
                        msg
                    }
                }
            )
        }
    }

    private fun finalizeStreamingMessage(messageId: String) {
        _state.update { state ->
            state.copy(
                messages = state.messages.map { msg ->
                    if (msg.id == messageId) {
                        msg.copy(isStreaming = false)
                    } else {
                        msg
                    }
                }
            )
        }
        streamingMessages.remove(messageId)
    }

    private fun finalizeStreamingMessages() {
        streamingMessages.keys.forEach { messageId ->
            finalizeStreamingMessage(messageId)
        }
    }

    private fun summarizeForLog(text: String?): String {
        if (text.isNullOrEmpty()) return ""
        val noNewlines = text.replace('\n', ' ')
        return if (noNewlines.length <= 120) noNewlines else noNewlines.take(117) + "…"
    }

    private fun addDisplayMessage(message: DisplayMessage) {
        _state.update { state ->
            state.copy(messages = state.messages + message)
        }
    }

    private fun generateMessageId(): String = "msg_${Clock.System.now().toEpochMilliseconds()}"
}

/**
 * Immutable view state for chat surfaces.
 */
data class ChatState(
    val activeAgent: AgentConfig? = null,
    val messages: List<DisplayMessage> = emptyList(),
    val ephemeralMessage: DisplayMessage? = null,
    val isLoading: Boolean = false,
    val isConnected: Boolean = false,
    val error: String? = null,
    val background: BackgroundStyle = BackgroundStyle.Default
)

/** Classic chat roles shown in the UI layers. */
enum class MessageRole {
    USER, ASSISTANT, SYSTEM, ERROR, TOOL_CALL, STEP_INFO
}

/** Distinguishes transient tool/step messages. */
enum class EphemeralType {
    TOOL_CALL, STEP
}

/** Representation of rendered chat messages for UIs. */
data class DisplayMessage(
    val id: String,
    val role: MessageRole,
    val content: String,
    val timestamp: Long = Clock.System.now().toEpochMilliseconds(),
    val isStreaming: Boolean = false,
    val ephemeralGroupId: String? = null,
    val ephemeralType: EphemeralType? = null
)
