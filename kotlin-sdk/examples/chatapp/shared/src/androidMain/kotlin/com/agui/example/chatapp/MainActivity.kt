package com.agui.example.chatapp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.agui.example.chatapp.App
import com.agui.example.chatapp.util.initializeAndroid
import org.slf4j.LoggerFactory

class MainActivity : ComponentActivity() {
    companion object {
        private val logger = LoggerFactory.getLogger(MainActivity::class.java)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Logback-android automatically initializes from assets/logback.xml
        logger.debug("MainActivity onCreate - Logback initialized")
        logger.info("Starting AG-UI4K Client")

        // Initialize Android-specific utilities
        initializeAndroid(this)

        setContent {
            App()
        }
    }
}