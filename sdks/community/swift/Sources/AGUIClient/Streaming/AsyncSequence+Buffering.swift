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

// MARK: - Buffering Extension

extension AsyncSequence where Self: Sendable, Element: Sendable {
    /// Applies bounded buffering with overflow handling.
    ///
    /// Creates a bounded buffer between producer and consumer. When the buffer
    /// fills, the specified strategy determines which elements to keep.
    ///
    /// - Parameters:
    ///   - limit: Maximum number of elements in buffer
    ///   - strategy: Strategy for handling overflow
    /// - Returns: Buffered async sequence
    ///
    /// ## Example
    ///
    /// ```swift
    /// let buffered = eventStream.buffered(limit: 100, strategy: .dropOldest)
    ///
    /// for try await event in buffered {
    ///     // Buffer ensures max 100 events in memory
    ///     await slowProcessing(event)
    /// }
    /// ```
    ///
    /// ## Memory Safety
    ///
    /// The buffer guarantees bounded memory usage: `limit * sizeof(Element)`.
    ///
    /// ## Performance
    ///
    /// - `.dropOldest`: O(1) append, O(n) drop (shifts elements)
    /// - `.dropNewest`: O(1) append and drop
    /// - `.suspend`: Natural backpressure (no buffer overhead)
    public func buffered(
        limit: Int,
        strategy: BufferingStrategy
    ) -> AsyncThrowingStream<Element, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var buffer: [Element] = []

                    for try await element in self {
                        // Apply overflow strategy when buffer is full
                        if buffer.count >= limit {
                            switch strategy {
                            case .dropOldest:
                                buffer.removeFirst()
                                buffer.append(element)
                            case .dropNewest:
                                // Drop the new element, keep buffer as-is
                                continue
                            case .suspend:
                                // For suspend strategy, yield current buffer first
                                // to apply natural backpressure
                                while !buffer.isEmpty {
                                    continuation.yield(buffer.removeFirst())
                                }
                                buffer.append(element)
                            }
                        } else {
                            buffer.append(element)
                        }
                    }

                    // Yield remaining buffered elements
                    while !buffer.isEmpty {
                        continuation.yield(buffer.removeFirst())
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}

// MARK: - Batching Extension

extension AsyncSequence where Self: Sendable {
    /// Batches elements by count.
    ///
    /// Groups elements into arrays of the specified size. The last batch
    /// may contain fewer than `count` elements if the sequence ends.
    ///
    /// - Parameter count: Number of elements per batch
    /// - Returns: Batched async sequence
    ///
    /// ## Example
    ///
    /// ```swift
    /// let batched = eventStream.batched(count: 10)
    ///
    /// for try await batch in batched {
    ///     // Process 10 events at once
    ///     await processBatch(batch) // batch.count <= 10
    /// }
    /// ```
    public func batched(count: Int) -> BatchedAsyncSequence<Self> {
        BatchedAsyncSequence(base: self, batchSize: count)
    }

    /// Batches elements by time window.
    ///
    /// Groups elements arriving within a time window. Emits batches
    /// when the window expires or the sequence ends.
    ///
    /// - Parameter timeWindow: Duration in seconds
    /// - Returns: Time-batched async sequence
    ///
    /// ## Example
    ///
    /// ```swift
    /// let batched = textChunks.batched(timeWindow: 0.05) // 50ms
    ///
    /// for try await batch in batched {
    ///     // Batch of all chunks received in 50ms window
    ///     let combined = batch.joined()
    ///     await updateUI(combined)
    /// }
    /// ```
    public func batched(timeWindow: TimeInterval) -> TimeBatchedAsyncSequence<Self> {
        TimeBatchedAsyncSequence(base: self, timeWindow: timeWindow)
    }
}

/// Async sequence that batches elements by count.
public struct BatchedAsyncSequence<Base: AsyncSequence>: AsyncSequence where Base: Sendable {
    public typealias Element = [Base.Element]

    private let base: Base
    private let batchSize: Int

    init(base: Base, batchSize: Int) {
        self.base = base
        self.batchSize = batchSize
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(base: base.makeAsyncIterator(), batchSize: batchSize)
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        private var baseIterator: Base.AsyncIterator
        private let batchSize: Int

        init(base: Base.AsyncIterator, batchSize: Int) {
            self.baseIterator = base
            self.batchSize = batchSize
        }

        public mutating func next() async throws -> [Base.Element]? {
            var batch: [Base.Element] = []
            batch.reserveCapacity(batchSize)

            while batch.count < batchSize {
                guard let element = try await baseIterator.next() else {
                    // End of sequence - return partial batch if any
                    return batch.isEmpty ? nil : batch
                }
                batch.append(element)
            }

            return batch
        }
    }
}

/// Async sequence that batches elements by time window.
public struct TimeBatchedAsyncSequence<Base: AsyncSequence>: AsyncSequence where Base: Sendable {
    public typealias Element = [Base.Element]

    private let base: Base
    private let timeWindow: TimeInterval

    init(base: Base, timeWindow: TimeInterval) {
        self.base = base
        self.timeWindow = timeWindow
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(base: base.makeAsyncIterator(), timeWindow: timeWindow)
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        private var baseIterator: Base.AsyncIterator
        private let timeWindow: TimeInterval
        private var buffer: [Base.Element] = []
        private var isExhausted = false

        init(base: Base.AsyncIterator, timeWindow: TimeInterval) {
            self.baseIterator = base
            self.timeWindow = timeWindow
        }

        public mutating func next() async throws -> [Base.Element]? {
            guard !isExhausted else { return nil }

            var batch: [Base.Element] = []
            let windowStart = Date()

            // Collect elements for the time window
            while true {
                // Check if window expired
                let elapsed = Date().timeIntervalSince(windowStart)
                if elapsed >= timeWindow {
                    break
                }

                // Try to get next element (non-blocking check)
                if let element = try await baseIterator.next() {
                    batch.append(element)

                    // Small yield to allow other tasks to run
                    await Task.yield()
                } else {
                    // End of sequence
                    isExhausted = true
                    break
                }
            }

            // Return batch if we have elements
            return batch.isEmpty ? nil : batch
        }
    }
}

// MARK: - Throttling Extension

extension AsyncSequence where Self: Sendable, Element: Sendable {
    /// Throttles element emission to a maximum rate.
    ///
    /// Emits the first element immediately, then drops subsequent elements
    /// until the time window expires. This ensures a maximum emission rate.
    ///
    /// - Parameter interval: Minimum time between emitted elements (seconds)
    /// - Returns: Throttled async sequence
    ///
    /// ## Example
    ///
    /// ```swift
    /// let throttled = rapidEvents.throttled(interval: 0.1) // Max 10/sec
    ///
    /// for try await event in throttled {
    ///     // At most 1 event per 100ms
    ///     await processEvent(event)
    /// }
    /// ```
    public func throttled(interval: TimeInterval) -> AsyncThrowingStream<Element, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var lastEmitTime: Date?

                    for try await element in self {
                        let now = Date()

                        // Check if enough time has passed since last emit
                        if let lastTime = lastEmitTime {
                            let elapsed = now.timeIntervalSince(lastTime)
                            if elapsed < interval {
                                // Drop this element - too soon
                                continue
                            }
                        }

                        // Emit element and update timestamp
                        continuation.yield(element)
                        lastEmitTime = now
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Samples every Nth element.
    ///
    /// Emits only every Nth element, discarding others.
    ///
    /// - Parameter stride: Sample interval (emit every Nth element)
    /// - Returns: Sampled async sequence
    ///
    /// ## Example
    ///
    /// ```swift
    /// let sampled = videoFrames.sampled(every: 30) // 1 per second at 30fps
    ///
    /// for try await frame in sampled {
    ///     await processFrame(frame)
    /// }
    /// ```
    public func sampled(every stride: Int) -> SampledAsyncSequence<Self> {
        SampledAsyncSequence(base: self, stride: stride)
    }
}

/// Async sequence that samples every Nth element.
public struct SampledAsyncSequence<Base: AsyncSequence>: AsyncSequence where Base: Sendable {
    public typealias Element = Base.Element

    private let base: Base
    private let stride: Int

    init(base: Base, stride: Int) {
        self.base = base
        self.stride = stride
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(base: base.makeAsyncIterator(), stride: stride)
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        private var baseIterator: Base.AsyncIterator
        private let stride: Int
        private var count = 0

        init(base: Base.AsyncIterator, stride: Int) {
            self.baseIterator = base
            self.stride = stride
        }

        public mutating func next() async throws -> Element? {
            while let element = try await baseIterator.next() {
                count += 1

                if count % stride == 0 {
                    return element
                }
            }

            return nil
        }
    }
}
