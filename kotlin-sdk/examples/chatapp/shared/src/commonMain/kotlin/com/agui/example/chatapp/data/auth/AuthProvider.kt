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

/**
 * Interface for authentication providers that handle different auth methods.
 */
interface AuthProvider {
    /**
     * Checks if this provider can handle the given auth method.
     */
    fun canHandle(authMethod: AuthMethod): Boolean
    
    /**
     * Applies authentication to the request headers.
     */
    suspend fun applyAuth(authMethod: AuthMethod, headers: MutableMap<String, String>)
    
    /**
     * Refreshes the authentication if needed (e.g., for OAuth tokens).
     */
    suspend fun refreshAuth(authMethod: AuthMethod): AuthMethod
    
    /**
     * Validates if the current authentication is still valid.
     */
    suspend fun isAuthValid(authMethod: AuthMethod): Boolean
}
