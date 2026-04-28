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

/// Errors that can occur during client operations.
public enum ClientError: Error {
    /// Invalid URL configuration.
    case invalidURL

    /// Received invalid response from server.
    case invalidResponse

    /// HTTP error with status code.
    case httpError(statusCode: Int)

    /// Network error occurred.
    case networkError(Error)

    /// Failed to decode event.
    case decodingError(Error)

    /// Stream processing error.
    case streamError(String)

    /// Request timed out.
    case timeout

    /// Request was cancelled.
    case cancelled
}

extension ClientError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL configuration"
        case .invalidResponse:
            return "Received invalid response from server"
        case .httpError(let code):
            return "HTTP error: \(code)"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .decodingError(let error):
            return "Failed to decode event: \(error.localizedDescription)"
        case .streamError(let message):
            return "Stream error: \(message)"
        case .timeout:
            return "Request timed out"
        case .cancelled:
            return "Request was cancelled"
        }
    }
}

extension ClientError: Equatable {
    public static func == (lhs: ClientError, rhs: ClientError) -> Bool {
        switch (lhs, rhs) {
        case (.invalidURL, .invalidURL),
             (.invalidResponse, .invalidResponse),
             (.timeout, .timeout),
             (.cancelled, .cancelled):
            return true
        case (.httpError(let lcode), .httpError(let rcode)):
            return lcode == rcode
        case (.streamError(let lmsg), .streamError(let rmsg)):
            return lmsg == rmsg
        case (.networkError(let lerr), .networkError(let rerr)):
            return lerr.localizedDescription == rerr.localizedDescription
        case (.decodingError(let lerr), .decodingError(let rerr)):
            return lerr.localizedDescription == rerr.localizedDescription
        default:
            return false
        }
    }
}
