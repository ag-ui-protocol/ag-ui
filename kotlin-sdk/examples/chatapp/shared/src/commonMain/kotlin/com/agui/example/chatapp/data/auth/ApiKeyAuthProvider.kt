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
package com.agui.example.chatapp.data.auth

import com.agui.example.chatapp.data.model.AuthMethod

class ApiKeyAuthProvider : AuthProvider {
    override fun canHandle(authMethod: AuthMethod): Boolean {
        return authMethod is AuthMethod.ApiKey
    }
    
    override suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>) {
        when (authMethod) {
            is AuthMethod.ApiKey -> {
                headers[authMethod.headerName] = authMethod.key
            }
            else -> throw IllegalArgumentException("Unsupported auth method")
        }
    }
    
    override suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod {
        // API keys don't need refreshing
        return authMethod
    }
    
    override suspend fun isAuthValid(authMethod: AuthMethod): Boolean {
        return authMethod is AuthMethod.ApiKey && authMethod.key.isNotBlank()
    }
}