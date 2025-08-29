package com.agui.example.chatapp

import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import com.agui.example.chatapp.App

fun main() = application {
    Window(
        onCloseRequest = ::exitApplication,
        title = "AG-UI Agent Chat"
    ) {
        App()
    }
}