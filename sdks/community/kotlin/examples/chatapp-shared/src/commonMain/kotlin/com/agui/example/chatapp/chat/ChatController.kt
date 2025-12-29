package com.agui.example.chatapp.chat

import co.touchlab.kermit.Logger
import com.agui.client.agent.AgentEventParams
import com.agui.client.agent.AgentStateChangedParams
import com.agui.client.agent.AgentStateMutation
import com.agui.client.agent.AgentSubscriber
import com.agui.client.agent.AgentSubscriberParams
import com.agui.client.agent.AgentSubscription
import com.agui.core.types.ActivityDeltaEvent
import com.agui.core.types.ActivityMessage
import com.agui.core.types.ActivitySnapshotEvent
import com.agui.core.types.AssistantMessage
import com.agui.core.types.BaseEvent
import com.agui.core.types.DeveloperMessage
import com.agui.core.types.Message
import com.agui.core.types.Role
import com.agui.core.types.RunErrorEvent
import com.agui.core.types.RunFinishedEvent
import com.agui.core.types.StateDeltaEvent
import com.agui.core.types.StateSnapshotEvent
import com.agui.core.types.StepFinishedEvent
import com.agui.core.types.StepStartedEvent
import com.agui.core.types.SystemMessage
import com.agui.core.types.TextMessageContentEvent
import com.agui.core.types.TextMessageEndEvent
import com.agui.core.types.TextMessageStartEvent
import com.agui.core.types.ToolCallArgsEvent
import com.agui.core.types.ToolCallEndEvent
import com.agui.core.types.ToolCallStartEvent
import com.agui.core.types.ToolMessage
import com.agui.core.types.UserMessage
import com.contextable.a2ui4k.data.DataModel
import com.contextable.a2ui4k.model.DataChangeEvent
import com.contextable.a2ui4k.model.UiDefinition
import com.contextable.a2ui4k.model.UiEvent
import com.contextable.a2ui4k.model.UserActionEvent
import com.contextable.a2ui4k.state.SurfaceStateManager
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
    private var agentSubscription: AgentSubscription? = null
    private var currentJob: Job? = null
    private var currentThreadId: String? = null

    private val toolCallBuffer = mutableMapOf<String, StringBuilder>()
    private val pendingToolCalls = mutableMapOf<String, String>()
    private val streamingMessageIds = mutableSetOf<String>()
    private val supplementalMessages = linkedMapOf<String, DisplayMessage>()
    private val ephemeralMessages = mutableMapOf<EphemeralType, DisplayMessage>()
    private val surfaceStateManager = SurfaceStateManager()
    private data class StoredMessage(var message: Message, val displayId: String)

    private val messageStore = mutableListOf<StoredMessage>()
    private val messageIdCounts = mutableMapOf<String, Int>()
    private val pendingUserMessages = mutableListOf<DisplayMessage>()

    private val agentSubscriber = ControllerAgentSubscriber()
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

            agentSubscription = currentAgent?.subscribe(agentSubscriber)

            currentThreadId = "thread_${Clock.System.now().toEpochMilliseconds()}"

            _state.update { it.copy(isConnected = true, error = null, background = BackgroundStyle.Default) }

            addSupplementalMessage(
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
        agentSubscription?.unsubscribe()
        agentSubscription = null
        currentAgent = null
        currentThreadId = null
        toolCallBuffer.clear()
        pendingToolCalls.clear()
        streamingMessageIds.clear()
        supplementalMessages.clear()
        ephemeralMessages.clear()
        messageStore.clear()
        messageIdCounts.clear()
        pendingUserMessages.clear()
        surfaceStateManager.clear()

        _state.update {
            it.copy(
                isConnected = false,
                messages = emptyList(),
                background = BackgroundStyle.Default,
                a2uiSurfaces = emptyMap()
            )
        }
    }

    fun sendMessage(content: String) {
        if (content.isBlank() || currentAgent == null || controllerClosed.value) return

        val trimmed = content.trim()
        val userMessage = DisplayMessage(
            id = generateMessageId(),
            role = MessageRole.USER,
            content = trimmed,
            isStreaming = true
        )
        pendingUserMessages += userMessage
        refreshMessages()

        startConversation(trimmed)
    }

    /**
     * Send an A2UI user action event back to the agent.
     * This is called when users interact with A2UI surfaces (button clicks, form submissions, etc.).
     *
     * ## Protocol Layers (A2UI → AG-UI → A2A)
     *
     * This implementation bridges three protocol layers:
     *
     * 1. **A2UI Spec** - Defines UI events with `name` field for action identification
     * 2. **AG-UI** - Uses `forwardedProps` to pass A2UI events through the transport layer
     * 3. **A2A (Agent-to-Agent)** - The `@ag-ui/a2a` integration converts `forwardedProps.a2uiAction`
     *    into an A2A DataPart with `mimeType: "application/json+a2ui"`
     *
     * ## A2UI ClientEvent Format (per spec)
     * ```json
     * {
     *   "name": "action_name",
     *   "surfaceId": "default",
     *   "sourceComponentId": "component-id:item1",
     *   "timestamp": "2025-12-17T02:00:23.936Z",
     *   "context": { ... }
     * }
     * ```
     *
     * ## Known Deviations from A2UI Spec
     *
     * 1. **`forwardedProps`** - AG-UI specific mechanism, not part of A2UI or A2A specs.
     *    The AG-UI A2A integration (`@ag-ui/a2a`) extracts `a2uiAction` from `forwardedProps`
     *    and creates an A2A DataPart. See: `ag-ui/integrations/a2a/typescript/src/agent.ts`
     *
     * 2. **`actionName` vs `name`** - The A2UI spec uses `name`, but CopilotKit's
     *    `@copilotkit/a2ui-renderer` transforms `action.name` to `actionName` when
     *    calling its onAction callback. Some demo backends (e.g., `CopilotKit/with-a2a-a2ui`)
     *    expect `actionName`. We send both for compatibility.
     *    See: `@copilotkit/a2ui-renderer/dist/A2UIViewer.js` line 97-98
     */
    fun sendA2UiAction(event: UiEvent) {
        // Per A2UI protocol: DataChangeEvent only updates local state (already done by the widget).
        // Only UserActionEvent (e.g., button clicks) should be sent to the server.
        if (event !is UserActionEvent) return
        if (currentAgent == null || controllerClosed.value) return

        // Build forwardedProps with A2UI ClientEvent at root
        // NOTE: forwardedProps is AG-UI specific. The @ag-ui/a2a integration extracts
        // a2uiAction and converts it to an A2A DataPart with mimeType "application/json+a2ui"
        val forwardedProps = buildJsonObject {
            put("a2uiAction", buildJsonObject {
                put("userAction", buildJsonObject {
                    // A2UI spec field
                    put("name", event.name)
                    // WORKAROUND: CopilotKit's a2ui-renderer transforms "name" to "actionName".
                    // Some demo apps expect "actionName" instead of the spec's "name".
                    // See: @copilotkit/a2ui-renderer/dist/A2UIViewer.js:97-98
                    put("actionName", event.name)
                    put("surfaceId", event.surfaceId)
                    put("sourceComponentId", event.sourceComponentId)
                    put("timestamp", event.timestamp)
                    event.context?.let { put("context", it) }
                })
            })
        }

        // Send as an action message with forwardedProps
        startConversationWithForwardedProps("[A2UI Action]", forwardedProps)
    }

    private fun startConversation(content: String) {
        startConversationWithForwardedProps(content, null)
    }

    private fun startConversationWithForwardedProps(content: String, forwardedProps: JsonElement?) {
        currentJob?.cancel()

        currentJob = scope.launch {
            _state.update { it.copy(isLoading = true) }

            try {
                val eventFlow = if (forwardedProps != null) {
                    currentAgent?.sendMessageWithForwardedProps(
                        message = content,
                        threadId = currentThreadId ?: "default",
                        forwardedProps = forwardedProps
                    )
                } else {
                    currentAgent?.sendMessage(
                        message = content,
                        threadId = currentThreadId ?: "default"
                    )
                }
                eventFlow?.collect { event ->
                    logger.d { "Received event: ${event::class.simpleName}" }
                }
            } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                // Cancellation is expected when starting a new request - don't show as error
                logger.d { "Request cancelled" }
            } catch (e: Exception) {
                logger.e(e) { "Error running agent" }
                addSupplementalMessage(
                    DisplayMessage(
                        id = generateMessageId(),
                        role = MessageRole.ERROR,
                        content = "${Strings.ERROR_PREFIX}${e.message}"
                    )
                )
            } finally {
                _state.update { it.copy(isLoading = false) }
                finalizeStreamingState()
                clearAllEphemeralMessages()
            }
        }
    }

    internal fun handleAgentEvent(event: BaseEvent) {
        logger.d { "Handling event: ${event::class.simpleName}" }
        agentSubscriber.handleManualEvent(event)
    }

    fun cancelCurrentOperation() {
        currentJob?.cancel()

        _state.update { it.copy(isLoading = false) }
        finalizeStreamingState()
        clearAllEphemeralMessages()
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

    internal fun updateMessagesFromAgent(messages: List<Message>) {
        if (messages.isEmpty()) {
            if (messageStore.isNotEmpty()) {
                messageStore.clear()
                messageIdCounts.clear()
                refreshMessages()
            }
            return
        }

        var changed = false

        messages.forEach { message ->
            changed = applyMessageUpdate(message) || changed
        }

        if (changed) {
            val conversation = messageStore.mapNotNull { stored ->
                stored.message.toDisplayMessage()?.copy(id = stored.displayId)
            }
            reconcilePendingUserMessages(conversation)
            refreshMessages()
        }
    }

    private fun Message.toDisplayMessage(): DisplayMessage? = when (this) {
        is DeveloperMessage -> DisplayMessage(
            id = id,
            role = MessageRole.DEVELOPER,
            content = content,
            isStreaming = streamingMessageIds.contains(id)
        )
        is SystemMessage -> DisplayMessage(
            id = id,
            role = MessageRole.SYSTEM,
            content = content ?: "",
            isStreaming = streamingMessageIds.contains(id)
        )
        is AssistantMessage -> DisplayMessage(
            id = id,
            role = MessageRole.ASSISTANT,
            content = formatAssistantContent(this),
            isStreaming = streamingMessageIds.contains(id)
        )
        is UserMessage -> if (content == "[A2UI Action]") null else DisplayMessage(
            id = id,
            role = MessageRole.USER,
            content = content,
            isStreaming = streamingMessageIds.contains(id)
        )
        is ToolMessage -> null
        // ActivityMessage doesn't produce a DisplayMessage - A2UI surfaces are
        // rendered separately from ChatState.a2uiSurfaces
        is ActivityMessage -> null
    }

    private fun formatAssistantContent(message: AssistantMessage): String =
        message.content?.takeIf { it.isNotBlank() } ?: ""

    private fun reconcilePendingUserMessages(agentMessages: List<DisplayMessage>) {
        if (pendingUserMessages.isEmpty()) return

        val userContents = agentMessages
            .filter { it.role == MessageRole.USER }
            .map { it.content }
            .toMutableList()

        if (userContents.isEmpty()) return

        val remaining = mutableListOf<DisplayMessage>()
        for (pending in pendingUserMessages.asReversed()) {
            val matchIndex = userContents.indexOfLast { it == pending.content }
            if (matchIndex >= 0) {
                userContents.removeAt(matchIndex)
            } else {
                remaining.add(0, pending)
            }
        }

        pendingUserMessages.clear()
        pendingUserMessages.addAll(remaining)
    }

    private fun applyMessageUpdate(message: Message): Boolean {
        val existing = messageStore.filter { it.message.id == message.id }
        val identical = existing.firstOrNull { it.message == message }
        if (identical != null) {
            return false
        }

        return when {
            message is UserMessage -> {
                val occurrence = messageIdCounts[message.id] ?: 0
                val stableId = if (occurrence == 0) message.id else "${message.id}#$occurrence"
                messageIdCounts[message.id] = occurrence + 1
                messageStore.add(StoredMessage(message, stableId))
                true
            }
            existing.isEmpty() -> {
                val occurrence = messageIdCounts[message.id] ?: 0
                val stableId = if (occurrence == 0) message.id else "${message.id}#$occurrence"
                messageIdCounts[message.id] = occurrence + 1
                messageStore.add(StoredMessage(message, stableId))
                true
            }
            else -> {
                val target = existing.last()
                target.message = message
                true
            }
        }
    }

    private fun summarizeArguments(arguments: String): String {
        val trimmed = arguments.trim()
        return if (trimmed.length <= 80) trimmed else trimmed.take(77) + "…"
    }

    private fun addSupplementalMessage(message: DisplayMessage) {
        supplementalMessages[message.id] = message
        refreshMessages()
    }

    private fun setEphemeralMessage(content: String, type: EphemeralType, icon: String = "") {
        val message = DisplayMessage(
            id = generateMessageId(),
            role = when (type) {
                EphemeralType.TOOL_CALL -> MessageRole.TOOL_CALL
                EphemeralType.STEP -> MessageRole.STEP_INFO
            },
            content = "$icon $content".trim(),
            ephemeralGroupId = type.name,
            ephemeralType = type
        )
        ephemeralMessages[type] = message
        refreshMessages()
    }

    private fun clearEphemeralMessage(type: EphemeralType) {
        if (ephemeralMessages.remove(type) != null) {
            refreshMessages()
        }
    }

    private fun clearAllEphemeralMessages() {
        if (ephemeralMessages.isNotEmpty()) {
            ephemeralMessages.clear()
            refreshMessages()
        }
    }

    private fun processStreamingAndEphemeral(event: BaseEvent) {
        var needsRefresh = false
        when (event) {
            is TextMessageStartEvent -> {
                streamingMessageIds += event.messageId
                needsRefresh = true
            }
            is TextMessageContentEvent -> Unit
            is TextMessageEndEvent -> {
                streamingMessageIds -= event.messageId
                needsRefresh = true
            }
            is ToolCallStartEvent -> {
                toolCallBuffer[event.toolCallId] = StringBuilder()
                pendingToolCalls[event.toolCallId] = event.toolCallName
                if (event.toolCallName != "change_background") {
                    setEphemeralMessage(
                        content = "Calling ${event.toolCallName}…",
                        type = EphemeralType.TOOL_CALL,
                        icon = "🔧"
                    )
                }
            }
            is ToolCallArgsEvent -> {
                toolCallBuffer[event.toolCallId]?.append(event.delta)
                val argsPreview = toolCallBuffer[event.toolCallId]?.toString().orEmpty()
                val toolName = pendingToolCalls[event.toolCallId]
                if (toolName != null && toolName != "change_background") {
                    setEphemeralMessage(
                        content = "Calling $toolName with: ${summarizeArguments(argsPreview)}",
                        type = EphemeralType.TOOL_CALL,
                        icon = "🔧"
                    )
                }
            }
            is ToolCallEndEvent -> {
                val toolName = pendingToolCalls.remove(event.toolCallId)
                toolCallBuffer.remove(event.toolCallId)
                if (toolName != "change_background") {
                    scope.launch {
                        delay(1000)
                        clearEphemeralMessage(EphemeralType.TOOL_CALL)
                    }
                }
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
            is RunErrorEvent -> {
                addSupplementalMessage(
                    DisplayMessage(
                        id = generateMessageId(),
                        role = MessageRole.ERROR,
                        content = "${Strings.AGENT_ERROR_PREFIX}${event.message}"
                    )
                )
            }
            is RunFinishedEvent -> clearAllEphemeralMessages()
            is StateDeltaEvent, is StateSnapshotEvent -> Unit
            is ActivitySnapshotEvent -> {
                if (event.activityType == "a2ui-surface") {
                    surfaceStateManager.processSnapshot(event.messageId, event.content)
                    updateA2UiSurfaces()
                }
            }
            is ActivityDeltaEvent -> {
                if (event.activityType == "a2ui-surface") {
                    surfaceStateManager.processDelta(event.messageId, event.patch)
                    updateA2UiSurfaces()
                }
            }
            else -> Unit
        }
        if (needsRefresh) {
            refreshMessages()
        }
    }

    private fun finalizeStreamingState() {
        streamingMessageIds.clear()
        for (i in pendingUserMessages.indices) {
            pendingUserMessages[i] = pendingUserMessages[i].copy(isStreaming = false)
        }
        refreshMessages()
    }

    private fun refreshMessages() {
        val conversation = messageStore.mapNotNull { stored ->
            stored.message.toDisplayMessage()?.copy(id = stored.displayId)
        }
        val pending = pendingUserMessages.toList()
        val supplemental = supplementalMessages.values.toList()
        val ephemerals = ephemeralMessages.values.toList()
        _state.update {
            it.copy(messages = supplemental + conversation + pending + ephemerals)
        }
    }

    private fun updateA2UiSurfaces() {
        val surfaces = surfaceStateManager.getSurfaces()
        val dataModels = surfaces.keys.mapNotNull { surfaceId ->
            surfaceStateManager.getDataModel(surfaceId)?.let { surfaceId to it }
        }.toMap()
        _state.update { it.copy(a2uiSurfaces = surfaces, a2uiDataModels = dataModels) }
    }

    /**
     * Returns the data model for a specific A2UI surface.
     */
    fun getA2UiDataModel(surfaceId: String) = surfaceStateManager.getDataModel(surfaceId)

    private inner class ControllerAgentSubscriber : AgentSubscriber {
        override suspend fun onRunInitialized(params: AgentSubscriberParams): AgentStateMutation? {
            updateMessagesFromAgent(params.messages)
            return null
        }

        override suspend fun onMessagesChanged(params: AgentStateChangedParams) {
            updateMessagesFromAgent(params.messages)
        }

        override suspend fun onEvent(params: AgentEventParams): AgentStateMutation? {
            processStreamingAndEphemeral(params.event)
            return null
        }

        override suspend fun onRunFinalized(params: AgentSubscriberParams): AgentStateMutation? {
            finalizeStreamingState()
            return null
        }

        fun handleManualEvent(event: BaseEvent) {
            logger.d { "Manual event received: ${event::class.simpleName} (id=${(event as? TextMessageStartEvent)?.messageId ?: (event as? TextMessageContentEvent)?.messageId ?: "n/a"})" }
            processStreamingAndEphemeral(event)
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
    val background: BackgroundStyle = BackgroundStyle.Default,
    val a2uiSurfaces: Map<String, UiDefinition> = emptyMap(),
    val a2uiDataModels: Map<String, DataModel> = emptyMap()
)

/** Classic chat roles shown in the UI layers. */
enum class MessageRole {
    USER, ASSISTANT, SYSTEM, DEVELOPER, ERROR, TOOL_CALL, STEP_INFO
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
    val ephemeralType: EphemeralType? = null,
    val surfaceId: String? = null
)
