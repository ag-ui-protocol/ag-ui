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

// MARK: - StreamingCursorView

/// A blinking vertical bar appended to a streaming message bubble.
///
/// Signals that the agent's response is still arriving. Fades out smoothly
/// when the message's `isStreaming` flag transitions to `false`.
struct StreamingCursorView: View {

    // MARK: - State

    @State private var visible: Bool = true

    // MARK: - Body

    var body: some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(Color.secondary.opacity(0.7))
            .frame(width: 2, height: 14)
            .opacity(visible ? 1 : 0)
            .onAppear {
                withAnimation(
                    .easeInOut(duration: 0.52)
                    .repeatForever(autoreverses: true)
                ) {
                    visible = false
                }
            }
    }
}

// MARK: - Previews

#Preview {
    HStack {
        Text("Streaming text")
        StreamingCursorView()
    }
    .padding()
}
