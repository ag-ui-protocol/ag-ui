package com.agui.example.chatapp.util

import com.russhwolf.settings.PreferencesSettings
import com.russhwolf.settings.Settings
import java.util.prefs.Preferences

actual fun getPlatformSettings(): Settings {
    val preferences = Preferences.userNodeForPackage(Settings::class.java)
    return PreferencesSettings(preferences)
}

actual fun getPlatformName(): String = "Desktop"

