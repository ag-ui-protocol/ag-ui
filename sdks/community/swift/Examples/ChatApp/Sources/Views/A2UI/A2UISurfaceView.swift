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

import SwiftUI

// MARK: - A2UISurfaceView

/// Root renderer for a single A2UI surface.
///
/// Decodes the raw JSON `surfaceData` into an `A2UIComponent` tree on each
/// render pass. Falls back to an empty view on parse failure so the layout
/// never breaks if the data is temporarily malformed during a streaming patch.
///
/// User interactions are forwarded through `onAction` so no store reference
/// is held inside the view hierarchy — this keeps the view pure and testable.
struct A2UISurfaceView: View {

    let messageId: String
    /// Raw JSON bytes for this surface, sourced from `ChatUIState.a2uiSurfaces`.
    let surfaceData: Data?
    /// `(messageId, actionId, payload)` — called when the user interacts with
    /// a button, toggle, text field, or select inside this surface.
    let onAction: (String, String, [String: String]) -> Void

    var body: some View {
        if let data = surfaceData,
           let root = try? JSONDecoder().decode(A2UIComponent.self, from: data) {
            A2UIComponentView(component: root) { actionId, payload in
                onAction(messageId, actionId, payload)
            }
            .padding(12)
            .background(Color(UIColor.secondarySystemBackground).opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }
}

// MARK: - Previews

#Preview("Text surface") {
    let json = """
    {"type": "vStack", "children": [
        {"type": "text", "content": "Hello from A2UI", "style": {"fontWeight": "bold"}},
        {"type": "divider"},
        {"type": "button", "label": "Tap me", "actionId": "tap"}
    ]}
    """.data(using: .utf8)

    A2UISurfaceView(
        messageId: "preview-1",
        surfaceData: json,
        onAction: { mId, actionId, payload in
            print("Action: \(actionId) on \(mId), payload: \(payload)")
        }
    )
    .padding()
}
