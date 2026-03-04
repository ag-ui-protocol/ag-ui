package com.agui.example.chatwear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.agui.example.chatwear.ui.ChatWearApp
import com.agui.example.chatapp.util.initializeAndroid

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initializeAndroid(this)

        setContent {
            ChatWearApp()
        }
    }
}
