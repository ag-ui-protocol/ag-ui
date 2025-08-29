package com.agui.example.chatapp.util

import android.content.Context
import com.russhwolf.settings.Settings
import com.russhwolf.settings.SharedPreferencesSettings

// Use nullable var instead of lateinit var to avoid initialization errors in tests
private var appContext: Context? = null

fun initializeAndroid(context: Context) {
    appContext = context.applicationContext
}

actual fun getPlatformSettings(): Settings {
    val context = appContext
    if (context == null) {
        throw IllegalStateException(
            "Android context not initialized. Call initializeAndroid(context) first. " +
                    "In tests, make sure to call initializeAndroid() in your @Before method."
        )
    }
    val sharedPreferences = context.getSharedPreferences("agui4k_prefs", Context.MODE_PRIVATE)
    return SharedPreferencesSettings(sharedPreferences)
}

actual fun getPlatformName(): String = "Android"

/**
 * Check if Android context has been initialized.
 * Useful for testing.
 */
fun isAndroidInitialized(): Boolean = appContext != null

/**
 * Get the current Android context if initialized.
 * Useful for testing.
 */
fun getAndroidContext(): Context? = appContext

/**
 * Reset the Android context (useful for testing).
 * Should only be used in tests.
 */
fun resetAndroidContext() {
    appContext = null
}