"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface SendMessageResult {
  success: boolean;
  messageId: string;
  response: {
    messaging_product: string;
    contacts: Array<{
      input: string;
      wa_id: string;
    }>;
    messages: Array<{
      id: string;
    }>;
  };
}

interface ConfigStatus {
  phoneNumberId: string;
  hasAccessToken: boolean;
  hasWebhookSecret: boolean;
  hasVerifyToken: boolean;
}

interface DebugResult {
  success?: boolean;
  error?: string;
  message?: string;
  phoneNumberInfo?: Record<string, unknown>;
  status?: number;
  response?: Record<string, unknown>;
}

export default function Home() {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<SendMessageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [debugResult, setDebugResult] = useState<DebugResult | null>(null);
  const [isDebugLoading, setIsDebugLoading] = useState(false);

  useEffect(() => {
    // Check configuration status
    fetch("/api/config")
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setConfigStatus(null);
        } else {
          setConfigStatus(data);
        }
      })
      .catch(() => {
        setConfigStatus(null);
      });
  }, []);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/send-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ phoneNumber, message }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to send message");
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDebugCredentials = async () => {
    setIsDebugLoading(true);
    setDebugResult(null);

    try {
      const response = await fetch("/api/debug");
      const data = await response.json();
      setDebugResult(data);
    } catch (err) {
      setDebugResult({
        error: err instanceof Error ? err.message : "Debug failed"
      });
    } finally {
      setIsDebugLoading(false);
    }
  };

  const isConfigured = configStatus && 
    configStatus.phoneNumberId && 
    configStatus.hasAccessToken && 
    configStatus.hasWebhookSecret && 
    configStatus.hasVerifyToken;

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            AG-UI WhatsApp Demo
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            A lean demonstration of AG-UI WhatsApp integration. Send messages and
            receive webhooks through the WhatsApp Business API.
          </p>
        </div>

        {/* Main Content */}
        <div className="max-w-2xl mx-auto">
          {/* Configuration Status */}
          <div className="bg-white rounded-lg shadow-md p-6 mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-gray-900">
                Configuration Status
              </h2>
              <div className="flex space-x-2">
                <button
                  onClick={handleDebugCredentials}
                  disabled={isDebugLoading || !isConfigured}
                  className="px-3 py-2 bg-yellow-600 text-white text-sm rounded-md hover:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isDebugLoading ? "Testing..." : "Debug Credentials"}
                </button>
                <Link
                  href="/config"
                  className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  Configure
                </Link>
              </div>
            </div>
            
            {configStatus ? (
              <div className="space-y-2">
                <div className="flex items-center">
                  <div className={`w-3 h-3 rounded-full mr-3 ${
                    configStatus.phoneNumberId ? "bg-green-500" : "bg-red-500"
                  }`}></div>
                  <span className="text-sm text-gray-600">
                    Phone Number ID: {configStatus.phoneNumberId ? "Configured" : "Not configured"}
                  </span>
                </div>
                <div className="flex items-center">
                  <div className={`w-3 h-3 rounded-full mr-3 ${
                    configStatus.hasAccessToken ? "bg-green-500" : "bg-red-500"
                  }`}></div>
                  <span className="text-sm text-gray-600">
                    Access Token: {configStatus.hasAccessToken ? "Configured" : "Not configured"}
                  </span>
                </div>
                <div className="flex items-center">
                  <div className={`w-3 h-3 rounded-full mr-3 ${
                    configStatus.hasWebhookSecret ? "bg-green-500" : "bg-red-500"
                  }`}></div>
                  <span className="text-sm text-gray-600">
                    Webhook Secret: {configStatus.hasWebhookSecret ? "Configured" : "Not configured"}
                  </span>
                </div>
                <div className="flex items-center">
                  <div className={`w-3 h-3 rounded-full mr-3 ${
                    configStatus.hasVerifyToken ? "bg-green-500" : "bg-red-500"
                  }`}></div>
                  <span className="text-sm text-gray-600">
                    Verify Token: {configStatus.hasVerifyToken ? "Configured" : "Not configured"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-center py-4">
                <p className="text-gray-500 mb-4">No configuration found</p>
                <Link
                  href="/config"
                  className="inline-block px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  Set Up Configuration
                </Link>
              </div>
            )}
          </div>

          {/* Debug Results */}
          {debugResult && (
            <div className={`bg-white rounded-lg shadow-md p-6 mb-8 ${
              debugResult.success ? "border-l-4 border-green-500" : "border-l-4 border-red-500"
            }`}>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">
                Debug Results
              </h3>
              {debugResult.success ? (
                <div className="text-green-700">
                  <p className="font-medium">✅ {debugResult.message || 'Credentials are valid'}</p>
                  {debugResult.phoneNumberInfo && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm">Phone Number Details</summary>
                      <pre className="mt-2 text-xs bg-gray-50 p-2 rounded overflow-auto">
                        {JSON.stringify(debugResult.phoneNumberInfo, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ) : (
                <div className="text-red-700">
                  <p className="font-medium">❌ {debugResult.error}</p>
                  {debugResult.status && (
                    <p className="text-sm mt-1">Status: {debugResult.status}</p>
                  )}
                  {debugResult.response && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm">Error Details</summary>
                      <pre className="mt-2 text-xs bg-gray-50 p-2 rounded overflow-auto">
                        {JSON.stringify(debugResult.response, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Send Message Form */}
          <div className="bg-white rounded-lg shadow-md p-6 mb-8">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Send WhatsApp Message
            </h2>
            
            {!isConfigured ? (
              <div className="text-center py-8">
                <div className="text-yellow-600 mb-4">
                  <svg className="h-12 w-12 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <p className="text-gray-600 mb-4">
                  Please configure your WhatsApp Business API settings first.
                </p>
                <Link
                  href="/config"
                  className="inline-block px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                >
                  Configure Now
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSendMessage} className="space-y-4">
                <div>
                  <label htmlFor="phoneNumber" className="block text-sm font-medium text-gray-700 mb-2">
                    Phone Number (with country code)
                  </label>
                  <input
                    type="tel"
                    id="phoneNumber"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="+1234567890"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 placeholder-gray-500"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-2">
                    Message
                  </label>
                  <textarea
                    id="message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Enter your message here..."
                    rows={4}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 placeholder-gray-500"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-green-600 text-white py-2 px-4 rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? "Sending..." : "Send Message"}
                </button>
              </form>
            )}
          </div>

          {/* Results */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8">
              <h3 className="text-lg font-semibold text-red-800 mb-2">Error</h3>
              <p className="text-red-700">{error}</p>
            </div>
          )}

          {result && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-8">
              <h3 className="text-lg font-semibold text-green-800 mb-2">Success!</h3>
              <div className="text-green-700">
                <p><strong>Message ID:</strong> {result.messageId}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm">View Full Response</summary>
                  <pre className="mt-2 text-xs bg-white p-2 rounded overflow-auto">
                    {JSON.stringify(result.response, null, 2)}
                  </pre>
                </details>
              </div>
            </div>
          )}

          {/* Webhook Info */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-blue-900 mb-4">
              Webhook Endpoint
            </h2>
            <p className="text-blue-800 mb-4">
              Configure your WhatsApp Business API webhook to point to:
            </p>
            <div className="bg-white p-3 rounded border">
              <code className="text-sm text-gray-800">
                {typeof window !== "undefined" ? `${window.location.origin}/api/webhook` : "/api/webhook"}
              </code>
            </div>
            <div className="mt-4 text-sm text-blue-700">
              <p><strong>Verify Token:</strong> Set this in your WhatsApp app configuration</p>
              <p><strong>Webhook Secret:</strong> Use this to verify incoming webhooks</p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center mt-12 text-gray-500">
          <p>
            Built with AG-UI and Next.js • 
            <a 
              href="https://github.com/hvpareja/ag-ui/tree/feat/whatsapp-adapter" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-green-600 hover:text-green-700 ml-1"
            >
              View Source
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
