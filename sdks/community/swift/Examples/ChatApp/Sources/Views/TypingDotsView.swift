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

// MARK: - TypingDotsView

/// Three animated dots shown while the agent is composing its first token.
///
/// Each dot bounces vertically with a staggered delay, matching the typing
/// indicator style common in modern chat applications.
struct TypingDotsView: View {

    // MARK: - State

    @State private var phase: Bool = false

    // MARK: - Body

    var body: some View {
        HStack(spacing: 5) {
            dot(delay: 0.00)
            dot(delay: 0.18)
            dot(delay: 0.36)
        }
        .onAppear {
            withAnimation(
                .easeInOut(duration: 0.54)
                .repeatForever(autoreverses: true)
            ) {
                phase = true
            }
        }
    }

    // MARK: - Private

    private func dot(delay: Double) -> some View {
        Circle()
            .fill(Color.secondary.opacity(0.6))
            .frame(width: 8, height: 8)
            .scaleEffect(phase ? 1.0 : 0.5)
            .offset(y: phase ? -4 : 0)
            .animation(
                .easeInOut(duration: 0.54)
                .repeatForever(autoreverses: true)
                .delay(delay),
                value: phase
            )
    }
}

// MARK: - Previews

#Preview {
    TypingDotsView()
        .padding()
}
