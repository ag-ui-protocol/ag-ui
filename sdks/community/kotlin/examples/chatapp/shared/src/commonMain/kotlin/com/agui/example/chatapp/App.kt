package com.agui.example.chatapp

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import com.agui.example.chatapp.ui.screens.chat.ChatScreen
import com.agui.example.chatapp.ui.screens.settings.SettingsScreen
import com.agui.example.chatapp.ui.theme.AgentChatTheme

@Composable
fun App() {
    AgentChatTheme {
        var currentScreen by remember { mutableStateOf<Screen>(Screen.Chat) }

        when (currentScreen) {
            Screen.Chat -> ChatScreen(onOpenSettings = { currentScreen = Screen.Settings })
            Screen.Settings -> SettingsScreen(onBack = { currentScreen = Screen.Chat })
        }
    }
}

private sealed interface Screen {
    data object Chat : Screen
    data object Settings : Screen
}
