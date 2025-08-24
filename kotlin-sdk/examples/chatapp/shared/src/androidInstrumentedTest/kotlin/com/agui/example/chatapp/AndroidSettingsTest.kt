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
package com.agui.example.chatapp

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.russhwolf.settings.SharedPreferencesSettings
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertNotNull
import kotlin.test.assertEquals

/**
 * Test Android-specific functionality without relying on global state.
 */
@RunWith(AndroidJUnit4::class)
class AndroidSettingsTest {

    @Test
    fun testDirectSharedPreferencesSettings() {
        // Get context directly
        val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
        assertNotNull(context)

        // Create settings directly without using the platform abstraction
        val sharedPrefs = context.getSharedPreferences("test_prefs", Context.MODE_PRIVATE)
        val settings = SharedPreferencesSettings(sharedPrefs)

        // Test basic operations
        settings.putString("test_key", "test_value")
        val value = settings.getString("test_key", "default")
        assertEquals("test_value", value)

        // Test other types
        settings.putInt("int_key", 42)
        assertEquals(42, settings.getInt("int_key", 0))

        settings.putBoolean("bool_key", true)
        assertEquals(true, settings.getBoolean("bool_key", false))

        // Clean up
        settings.clear()
    }

    @Test
    fun testContextAvailable() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertNotNull(context)
        assertNotNull(context.applicationContext)
    }

    @Test
    fun testInstrumentationAvailable() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assertNotNull(instrumentation)
        assertNotNull(instrumentation.targetContext)
    }
}