package com.agui.example.chatapp.ui.screens.chat.components

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.contextable.a2ui4k.catalog.CoreCatalog
import com.contextable.a2ui4k.data.DataModel
import com.contextable.a2ui4k.model.UiDefinition
import com.contextable.a2ui4k.model.UiEvent
import com.contextable.a2ui4k.render.A2UISurface
import com.agui.example.chatapp.chat.DisplayMessage
import com.agui.example.chatapp.chat.MessageRole
import kotlinx.coroutines.launch

@Composable
fun MessageList(
    messages: List<DisplayMessage>,
    isLoading: Boolean,
    a2uiSurfaces: Map<String, UiDefinition> = emptyMap(),
    a2uiDataModels: Map<String, DataModel> = emptyMap(),
    onA2UiEvent: (UiEvent) -> Unit = {},
    modifier: Modifier = Modifier
) {
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()

    // When A2UI surfaces are present, hide assistant text messages (they're duplicated in the surface)
    val filteredMessages = if (a2uiSurfaces.isNotEmpty()) {
        messages.filter { it.role != MessageRole.ASSISTANT }
    } else {
        messages
    }

    // Auto-scroll to bottom when new messages or surfaces arrive
    LaunchedEffect(filteredMessages.size, a2uiSurfaces.size) {
        val totalItems = filteredMessages.size + a2uiSurfaces.size
        if (totalItems > 0) {
            coroutineScope.launch {
                listState.animateScrollToItem(totalItems - 1)
            }
        }
    }

    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        items(
            items = filteredMessages,
            key = { it.id }
        ) { message ->
            MessageBubble(message = message)
        }

        // Render A2UI surfaces after messages
        a2uiSurfaces.forEach { (surfaceId, definition) ->
            item(key = "a2ui-$surfaceId") {
                val dataModel = a2uiDataModels[surfaceId]
                if (dataModel != null) {
                    A2UISurface(
                        definition = definition,
                        dataModel = dataModel,
                        catalog = CoreCatalog,
                        onEvent = onA2UiEvent,
                        modifier = Modifier
                            .fillMaxWidth()
                            .wrapContentHeight()
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                } else {
                    A2UISurface(
                        definition = definition,
                        catalog = CoreCatalog,
                        onEvent = onA2UiEvent,
                        modifier = Modifier
                            .fillMaxWidth()
                            .wrapContentHeight()
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                }
            }
        }

        if (isLoading && messages.none { it.isStreaming }) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp)
                    )
                }
            }
        }
    }
}
