/*
 * MIT License
 *
 * Copyright (c) 2025 Perfect Aduh
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

import AGUIClient
import AGUICore
import Foundation

/// AGUIAgentSDK provides high-level APIs for common agent interaction patterns.
///
/// This module offers convenient, easy-to-use APIs for building AI agent user interfaces.
/// It builds on top of AGUICore and AGUIClient to provide a streamlined developer experience.
///
/// Key Components:
/// - **AgUiAgent**: Stateless client for cases where no ongoing context is needed
/// - **StatefulAgUiAgent**: Stateful client that maintains conversation history
/// - **Builders**: Convenient builder patterns for agent configuration
public struct AGUIAgentSDK {
    /// AGUIAgentSDK version
    public static let version = "1.0.0"

    public init() {}
}
