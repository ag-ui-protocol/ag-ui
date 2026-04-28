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

import Foundation

/// Unified list-item type for the chat message list.
///
/// Merges ``DisplayMessage`` (agent-originated content) and
/// ``SupplementalMessage`` (system-originated events) into a single
/// sequence for `ForEach` iteration in `ChatView`.
enum ChatRow: Identifiable, Sendable {
    case agent(DisplayMessage)
    case supplemental(SupplementalMessage)

    // MARK: - Identifiable

    var id: String {
        switch self {
        case .agent(let m): return m.id
        case .supplemental(let s): return s.id
        }
    }

    // MARK: - Sorting

    var timestamp: Date {
        switch self {
        case .agent(let m): return m.timestamp
        case .supplemental(let s): return s.timestamp
        }
    }
}
