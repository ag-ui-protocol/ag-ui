package com.agui.example.chatapp.data

import com.agui.example.chatapp.data.auth.AuthManager
import com.agui.example.chatapp.data.auth.AuthProvider
import com.agui.example.chatapp.data.model.AuthMethod
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlinx.coroutines.test.runTest

class AuthManagerTest {

    @Test
    fun applyAuth_withApiKey_addsHeader() = runTest {
        val manager = AuthManager()
        val headers = mutableMapOf<String, String>()

        manager.applyAuth(AuthMethod.ApiKey(key = "secret", headerName = "X-Secret"), headers)

        assertEquals("secret", headers["X-Secret"])
    }

    @Test
    fun registerProvider_customProviderTakesPriority() = runTest {
        val manager = AuthManager()
        val headers = mutableMapOf<String, String>()
        val calls = mutableListOf<String>()

        val customProvider = object : AuthProvider {
            override fun canHandle(authMethod: AuthMethod): Boolean = authMethod is AuthMethod.ApiKey

            override suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {
                calls += "apply"
                headers["Authorization"] = "Custom ${ (authMethod as AuthMethod.ApiKey).key }"
            }

            override suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod {
                calls += "refresh"
                return authMethod
            }

            override suspend fun isAuthValid(authMethod: AuthMethod): Boolean {
                calls += "validate"
                return true
            }
        }

        manager.registerProvider(customProvider)
        manager.applyAuth(AuthMethod.ApiKey(key = "override"), headers)

        assertEquals("Custom override", headers["Authorization"])
        assertFalse(headers.containsKey("X-API-Key"))
        assertEquals(listOf("apply"), calls)
    }

    @Test
    fun applyAuth_withoutProvider_throws() = runTest {
        val manager = AuthManager()
        val headers = mutableMapOf<String, String>()

        assertFailsWith<IllegalArgumentException> {
            manager.applyAuth(AuthMethod.Custom(type = "unknown", config = emptyMap()), headers)
        }
    }
}
