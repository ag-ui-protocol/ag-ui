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

import AGUIAgentSDK
import AGUICore
import Foundation

/// A scriptable `AgUiAgent` subclass used in unit tests.
///
/// Set `events` before calling any store method that triggers a run.
/// Set `errorToThrow` to simulate network or protocol errors.
final class MockAgUiAgent: AgUiAgent {
    /// Ordered events to emit when `run(input:)` is called.
    var events: [any AGUIEvent] = []
    /// When non-nil, this error is thrown instead of emitting events.
    var errorToThrow: Error?

    init() {
        // URL is unused — `run(input:)` is fully overridden.
        super.init(url: URL(string: "https://mock.test.local")!)
    }

    override func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        let events = self.events
        let error = self.errorToThrow
        return AsyncThrowingStream { continuation in
            Task {
                if let error {
                    continuation.finish(throwing: error)
                    return
                }
                for event in events {
                    continuation.yield(event)
                }
                continuation.finish()
            }
        }
    }
}
