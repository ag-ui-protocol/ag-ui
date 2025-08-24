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
import com.agui.example.chatapp.util.getPlatformName
import com.agui.example.chatapp.util.initializeAndroid
import com.agui.example.chatapp.util.getPlatformSettings
import com.agui.example.chatapp.util.isAndroidInitialized
import com.agui.example.chatapp.util.resetAndroidContext
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Before
import org.junit.After
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.assertEquals
import kotlin.test.assertFalse

@RunWith(AndroidJUnit4::class)
class AndroidIntegrationTest {

    @Before
    fun setup() {
        println("=== AndroidIntegrationTest setup ===")

        // Reset any previous state
        resetAndroidContext()

        // Verify we start clean
        assertFalse(isAndroidInitialized(), "Should start with clean state")

        // Get the context and initialize
        val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
        println("Got context: ${context::class.simpleName}")

        initializeAndroid(context)

        // Verify initialization worked
        assertTrue(isAndroidInitialized(), "Should be initialized after setup")
        println("✓ Android initialized successfully")
    }

    @After
    fun tearDown() {
        println("=== AndroidIntegrationTest tearDown ===")
        resetAndroidContext()
    }

    @Test
    fun testAndroidContextInitialization() {
        // Just verify that initialization worked
        assertTrue(isAndroidInitialized())
        println("✓ Context is initialized")
    }

    @Test
    fun testAndroidSettingsInitialization() {
        // Verify we're properly initialized
        assertTrue(
            isAndroidInitialized(),
            "Context should be initialized before testing settings"
        )

        // Get platform settings - this is where the error was occurring
        val settings = try {
            getPlatformSettings()
        } catch (e: Exception) {
            println("ERROR getting platform settings: ${e.message}")
            println("Is Android initialized: ${isAndroidInitialized()}")
            throw e
        }

        assertNotNull(settings)
        println("✓ Got platform settings successfully")

        // Test basic settings operations
        val testKey = "test_integration_key"
        val testValue = "test_integration_value"

        // Write
        settings.putString(testKey, testValue)

        // Read
        val retrievedValue = settings.getString(testKey, "default")
        assertEquals(testValue, retrievedValue)
        println("✓ Settings read/write operations work")

        // Clean up
        settings.remove(testKey)
        val afterRemoval = settings.getString(testKey, "default")
        assertEquals("default", afterRemoval)
        println("✓ Settings cleanup works")
    }

    @Test
    fun testPlatformName() {
        val platformName = getPlatformName()
        assertEquals("Android", platformName)
        println("✓ Platform name is correct: $platformName")
    }

    @Test
    fun testMultipleSettingsOperations() {
        assertTrue(isAndroidInitialized())

        val settings = getPlatformSettings()

        // Test different data types
        settings.putString("string_test", "hello")
        settings.putInt("int_test", 42)
        settings.putBoolean("bool_test", true)
        settings.putFloat("float_test", 3.14f)

        assertEquals("hello", settings.getString("string_test", ""))
        assertEquals(42, settings.getInt("int_test", 0))
        assertEquals(true, settings.getBoolean("bool_test", false))
        assertEquals(3.14f, settings.getFloat("float_test", 0.0f))

        // Clean up
        settings.remove("string_test")
        settings.remove("int_test")
        settings.remove("bool_test")
        settings.remove("float_test")

        println("✓ Multiple data types work correctly")
    }
}