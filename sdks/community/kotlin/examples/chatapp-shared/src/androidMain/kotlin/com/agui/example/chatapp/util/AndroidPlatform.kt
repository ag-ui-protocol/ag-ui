package com.agui.example.chatapp.util

import android.content.Context
import com.russhwolf.settings.Settings
import com.russhwolf.settings.SharedPreferencesSettings

private var appContext: Context? = null

fun initializeAndroid(context: Context) {
    appContext = context.applicationContext
}

actual fun getPlatformSettings(): Settings {
    val context = appContext
        ?: throw IllegalStateException(
            "Android context not initialized. Call initializeAndroid(context) first. " +
                "In tests, make sure to call initializeAndroid() before accessing platform settings."
        )
    val sharedPreferences = context.getSharedPreferences("agui4k_prefs", Context.MODE_PRIVATE)
    return SharedPreferencesSettings(sharedPreferences)
}

actual fun getPlatformName(): String = "Android"

fun isAndroidInitialized(): Boolean = appContext != null

fun getAndroidContext(): Context? = appContext

fun resetAndroidContext() {
    appContext = null
}
