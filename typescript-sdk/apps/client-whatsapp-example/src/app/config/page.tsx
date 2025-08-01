"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface ConfigForm {
  phoneNumberId: string;
  accessToken: string;
  webhookSecret: string;
  verifyToken: string;
}

export default function ConfigPage() {
  const router = useRouter();
  const [form, setForm] = useState<ConfigForm>({
    phoneNumberId: "",
    accessToken: "",
    webhookSecret: "",
    verifyToken: "",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);

  useEffect(() => {
    // Load existing config from API
    fetch("/api/config")
      .then(res => res.json())
      .then(data => {
        if (!data.error && data.phoneNumberId) {
          setForm({
            phoneNumberId: data.phoneNumberId,
            accessToken: "", // Don't load sensitive data
            webhookSecret: "", // Don't load sensitive data
            verifyToken: "", // Don't load sensitive data
          });
        }
      })
      .catch(() => {
        // Config not found, start with empty form
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage(null);

    try {
      const response = await fetch("/api/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to save configuration");
      }

      setMessage({
        type: "success",
        text: "Configuration saved successfully! Redirecting to main page..."
      });

      // Redirect back to main page after a short delay
      setTimeout(() => {
        router.push("/");
      }, 2000);
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to save configuration. Please try again."
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (field: keyof ConfigForm, value: string) => {
    setForm(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const generateRandomToken = () => {
    const token = Math.random().toString(36).substring(2, 15) + 
                  Math.random().toString(36).substring(2, 15);
    handleInputChange("verifyToken", token);
  };

  const generateRandomSecret = () => {
    const secret = Math.random().toString(36).substring(2, 15) + 
                   Math.random().toString(36).substring(2, 15) +
                   Math.random().toString(36).substring(2, 15);
    handleInputChange("webhookSecret", secret);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            WhatsApp Configuration
          </h1>
          <p className="text-gray-600">
            Configure your WhatsApp Business API settings securely
          </p>
        </div>

        <div className="max-w-2xl mx-auto">
          {/* Security Notice */}
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
            <div className="flex">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-yellow-800">
                  Security Notice
                </h3>
                <div className="mt-2 text-sm text-yellow-700">
                  <p>
                    This is a demo application. In production, these secrets should be stored securely 
                    on your server using environment variables or a secure configuration service.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Configuration Form */}
          <div className="bg-white rounded-lg shadow-md p-6">
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Phone Number ID */}
              <div>
                <label htmlFor="phoneNumberId" className="block text-sm font-medium text-gray-700 mb-2">
                  Phone Number ID
                </label>
                <input
                  type="text"
                  id="phoneNumberId"
                  value={form.phoneNumberId}
                  onChange={(e) => handleInputChange("phoneNumberId", e.target.value)}
                  placeholder="123456789012345"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-500"
                  required
                />
                <p className="mt-1 text-xs text-gray-500">
                  Found in your WhatsApp Business API dashboard
                </p>
              </div>

              {/* Access Token */}
              <div>
                <label htmlFor="accessToken" className="block text-sm font-medium text-gray-700 mb-2">
                  Access Token
                </label>
                <div className="relative">
                  <input
                    type={showSecrets ? "text" : "password"}
                    id="accessToken"
                    value={form.accessToken}
                    onChange={(e) => handleInputChange("accessToken", e.target.value)}
                    placeholder="EAA..."
                    className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-500"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecrets(!showSecrets)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center"
                  >
                    {showSecrets ? (
                      <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                      </svg>
                    ) : (
                      <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Generated from your Meta Developer account
                </p>
              </div>

              {/* Webhook Secret */}
              <div>
                <label htmlFor="webhookSecret" className="block text-sm font-medium text-gray-700 mb-2">
                  Webhook Secret
                </label>
                <div className="flex space-x-2">
                  <div className="relative flex-1">
                    <input
                      type={showSecrets ? "text" : "password"}
                      id="webhookSecret"
                      value={form.webhookSecret}
                      onChange={(e) => handleInputChange("webhookSecret", e.target.value)}
                      placeholder="your-webhook-secret"
                      className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-500"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecrets(!showSecrets)}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center"
                    >
                      {showSecrets ? (
                        <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                        </svg>
                      ) : (
                        <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={generateRandomSecret}
                    className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                  >
                    Generate
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Used to verify webhook signatures
                </p>
              </div>

              {/* Verify Token */}
              <div>
                <label htmlFor="verifyToken" className="block text-sm font-medium text-gray-700 mb-2">
                  Verify Token
                </label>
                <div className="flex space-x-2">
                  <input
                    type="text"
                    id="verifyToken"
                    value={form.verifyToken}
                    onChange={(e) => handleInputChange("verifyToken", e.target.value)}
                    placeholder="your-verify-token"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder-gray-500"
                    required
                  />
                  <button
                    type="button"
                    onClick={generateRandomToken}
                    className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                  >
                    Generate
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Used for webhook verification challenge
                </p>
              </div>

              {/* Message */}
              {message && (
                <div className={`p-4 rounded-md ${
                  message.type === "success" 
                    ? "bg-green-50 border border-green-200 text-green-800" 
                    : "bg-red-50 border border-red-200 text-red-800"
                }`}>
                  {message.text}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex space-x-4">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? "Saving..." : "Save Configuration"}
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/")}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>

          {/* Help Section */}
          <div className="mt-8 bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">How to Get These Values</h3>
            <div className="space-y-4 text-sm text-gray-600">
              <div>
                <h4 className="font-medium text-gray-900">Phone Number ID</h4>
                <p>Found in your WhatsApp Business API dashboard under Phone Numbers</p>
              </div>
              <div>
                <h4 className="font-medium text-gray-900">Access Token</h4>
                <p>Generate from Meta Developer Console → System Users → Generate Token</p>
              </div>
              <div>
                <h4 className="font-medium text-gray-900">Webhook Secret</h4>
                <p>Create a strong secret for verifying webhook signatures</p>
              </div>
              <div>
                <h4 className="font-medium text-gray-900">Verify Token</h4>
                <p>Any string you choose for webhook verification challenges</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
} 