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

/// Represents a structured activity update in the conversation.
///
/// `ActivityMessage` enables agents to stream dynamic UI elements, progress indicators,
/// A2UI surfaces, and other structured content beyond simple text messages.
///
/// ## Activity Types
///
/// The `activityType` field identifies the kind of activity:
/// - **Progress**: Progress indicators and status updates
/// - **Visualization**: Charts, graphs, and data visualizations
/// - **A2UI Surface**: Interactive UI components (forms, buttons, etc.)
/// - **Status**: System status and state updates
/// - **Custom**: Application-specific activity types
///
/// ## Activity Content
///
/// The `activityContent` field stores flexible JSON data as a `Data` object,
/// allowing each activity type to define its own content structure.
///
/// ## Usage Examples
///
/// ```swift
/// // Progress indicator
/// let progressContent = Data("""
/// {
///     "percent": 75,
///     "message": "Processing files...",
///     "current": 15,
///     "total": 20
/// }
/// """.utf8)
///
/// let progress = ActivityMessage(
///     id: "progress-1",
///     activityType: "progress",
///     activityContent: progressContent
/// )
///
/// // Chart visualization
/// let chartContent = Data("""
/// {
///     "chartType": "bar",
///     "data": {
///         "labels": ["Q1", "Q2", "Q3", "Q4"],
///         "datasets": [
///             {"label": "Sales", "values": [100, 150, 120, 180]}
///         ]
///     }
/// }
/// """.utf8)
///
/// let chart = ActivityMessage(
///     id: "viz-1",
///     activityType: "chart",
///     activityContent: chartContent
/// )
///
/// // A2UI form surface
/// let formContent = Data("""
/// {
///     "surfaceType": "form",
///     "fields": [
///         {"name": "email", "type": "text"},
///         {"name": "submit", "type": "button"}
///     ]
/// }
/// """.utf8)
///
/// let form = ActivityMessage(
///     id: "surface-1",
///     activityType: "a2ui-form",
///     activityContent: formContent
/// )
/// ```
///
/// ## Message Protocol
///
/// ActivityMessage conforms to the Message protocol, but `content` and `name`
/// are always `nil` since activities use structured `activityContent` instead.
///
/// - SeeAlso: ``Message``, ``Role``
public struct ActivityMessage: Message, Sendable, Hashable {
    /// The unique identifier for this message.
    public let id: String

    /// The message role (always `.activity`).
    public let role: Role

    /// The type of activity being reported.
    ///
    /// Common activity types:
    /// - `"progress"`: Progress indicators and completion status
    /// - `"chart"`: Data visualizations and charts
    /// - `"a2ui-form"`: Interactive form surfaces
    /// - `"status"`: System status updates
    /// - Custom application-specific types
    public let activityType: String

    /// The structured activity content as JSON data.
    ///
    /// This field contains a JSON object with activity-specific data.
    /// The structure varies based on the `activityType`.
    public let activityContent: Data

    /// Text content (always `nil` for activity messages).
    ///
    /// ActivityMessage uses `activityContent` for structured data
    /// instead of text content.
    public let content: String? = nil

    /// Optional sender name (always `nil` for activity messages).
    public let name: String? = nil

    /// Creates a new activity message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for the message
    ///   - activityType: The type of activity
    ///   - activityContent: JSON data representing the activity content
    public init(
        id: String,
        activityType: String,
        activityContent: Data
    ) {
        self.id = id
        self.role = .activity
        self.activityType = activityType
        self.activityContent = activityContent
    }
}
