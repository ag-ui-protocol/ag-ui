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