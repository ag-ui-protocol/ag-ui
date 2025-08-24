/*
 * MIT License
 *
 * Copyright (c) 2025 Mark Fogle
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
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