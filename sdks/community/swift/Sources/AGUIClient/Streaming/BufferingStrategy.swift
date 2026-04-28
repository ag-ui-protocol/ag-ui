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

/// Strategy for handling buffer overflow.
///
/// When a bounded buffer fills up and new elements arrive, the strategy
/// determines which elements to keep and which to drop.
///
/// ## Usage
///
/// ```swift
/// let buffered = stream.buffered(limit: 100, strategy: .dropOldest)
/// ```
public enum BufferingStrategy: Sendable {
    /// Drop the oldest elements when buffer is full.
    ///
    /// This strategy keeps the most recent elements, which is useful when
    /// you want the latest state and older data can be safely discarded.
    ///
    /// **Use case**: Real-time monitoring where only current values matter.
    ///
    /// ## Example
    ///
    /// ```
    /// Buffer: [1, 2, 3, 4, 5] (limit: 5)
    /// New: 6
    /// Result: [2, 3, 4, 5, 6] // Dropped 1
    /// ```
    case dropOldest

    /// Drop the newest elements when buffer is full.
    ///
    /// This strategy preserves the oldest elements, which is useful when
    /// historical data is important and newer data can be discarded.
    ///
    /// **Use case**: Processing a queue where order matters and you want
    /// to ensure early events are handled.
    ///
    /// ## Example
    ///
    /// ```
    /// Buffer: [1, 2, 3, 4, 5] (limit: 5)
    /// New: 6
    /// Result: [1, 2, 3, 4, 5] // Dropped 6
    /// ```
    case dropNewest

    /// Block the producer when buffer is full (natural backpressure).
    ///
    /// This strategy applies backpressure by suspending the producer
    /// until the consumer frees space in the buffer.
    ///
    /// **Use case**: When all events must be processed and loss is unacceptable.
    ///
    /// ## Example
    ///
    /// ```
    /// Buffer: [1, 2, 3, 4, 5] (limit: 5)
    /// New: 6 (producer suspends until consumer reads)
    /// ```
    ///
    /// **Note**: This is the natural behavior of AsyncSequence iteration
    /// and doesn't require explicit buffering.
    case suspend
}
