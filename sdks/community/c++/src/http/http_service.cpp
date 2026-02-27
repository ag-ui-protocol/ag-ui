#include "http/http_service.h"
#include <iostream>
#include <thread>
#include <curl/curl.h>

namespace agui {

std::unique_ptr<IHttpService> HttpServiceFactory::createCurlService() {
    return std::make_unique<HttpService>();
}

HttpService::HttpService() {
    // Initialize libcurl (global initialization, only once)
    static bool initialized = false;
    if (!initialized) {
        curl_global_init(CURL_GLOBAL_DEFAULT);
        initialized = true;
    }
}

HttpService::~HttpService() {
    // Note: Do not call curl_global_cleanup() here as there may be multiple instances
}

void HttpService::sendRequest(const HttpRequest& request, HttpResponseCallback onResponse,
                                  HttpErrorCallback onError) {
    // Network requests should be executed in a separate thread to avoid blocking
    CURL* curl = curl_easy_init();
    if (!curl) {
        throw std::runtime_error("Failed to initialize CURL");
    }

    HttpResponse response;
    struct curl_slist* headers = nullptr;

    try {
        // Set common options
        setupCurlOptions(curl, request, &headers);

        // Set response callback
        std::string responseBody;
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseBody);

        // Execute request
        CURLcode res = curl_easy_perform(curl);

        if (res != CURLE_OK) {
            std::string errorMsg = "CURL error: ";
            errorMsg += curl_easy_strerror(res);
            throw std::runtime_error(errorMsg);
        }

        // Get response status code
        long statusCode;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &statusCode);

        // Build response
        response.statusCode = static_cast<int>(statusCode);
        response.body = responseBody;
        response.content = responseBody;

        // Get response headers (simplified)
        response.headers["Content-Type"] = "application/json";

        // Cleanup
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);

    } catch (...) {
        if (headers) {
            curl_slist_free_all(headers);
        }
        curl_easy_cleanup(curl);
    }
}

void HttpService::sendSseRequest(const HttpRequest& request, SseDataCallback onData,
                                    SseCompleteCallback onComplete, HttpErrorCallback onError) {
    // Network requests should be executed in a separate thread to avoid blocking
    CURL* curl = curl_easy_init();
    if (!curl) {
        std::cout << "[HttpService] Failed to initialize CURL" << std::endl;
        if (onError) {
            onError(AgentError(ErrorType::Network, ErrorCode::NetworkError, "Failed to initialize CURL"));
        }
        return;
    }

    struct curl_slist* headers = nullptr;

    try {
        // Set common options (excluding total timeout)
        setupCurlOptions(curl, request, &headers);

        // SSE-specific configuration
        // 1. Remove total timeout limit for long-lived SSE connections
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 0L);
        
        // 2. Set connection timeout only (30 seconds is sufficient)
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 30000L);
        
        // 3. Set low-speed timeout to detect network failures
        curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 60L);
        curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1L);
        
        // 4. Enable TCP keep-alive to detect dead connections
        curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);
        curl_easy_setopt(curl, CURLOPT_TCP_KEEPIDLE, 120L);
        curl_easy_setopt(curl, CURLOPT_TCP_KEEPINTVL, 60L);

        // 5. Add SSE-specific headers
        headers = curl_slist_append(headers, "Accept: text/event-stream");
        headers = curl_slist_append(headers, "Cache-Control: no-cache");
        headers = curl_slist_append(headers, "Connection: keep-alive");
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);

        // Create cancel flag
        std::atomic<bool> cancelFlag(false);
        {
            std::lock_guard<std::mutex> lock(m_cancelMutex);
            m_cancelFlags[request.url];
            m_cancelFlags[request.url].store(false);
        }

        // Set streaming callback
        SseCallbackContext context(onData, &cancelFlag);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, sseWriteCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &context);

        // Execute request
        std::cout << "[HttpService] Starting SSE request..." << std::endl;
        CURLcode res = curl_easy_perform(curl);
        std::cout << "[HttpService] curl_easy_perform completed, return code: " << res << std::endl;

        // Cleanup cancel flag
        {
            std::lock_guard<std::mutex> lock(m_cancelMutex);
            m_cancelFlags.erase(request.url);
        }

        if (res != CURLE_OK) {
            std::string errorMsg = "CURL error: ";
            errorMsg += curl_easy_strerror(res);
            std::cout << "[HttpService] CURL error: " << errorMsg << std::endl;
            if (onError) {
                onError(AgentError(ErrorType::Network, ErrorCode::NetworkError, errorMsg));
            }
        } else {
            std::cout << "[HttpService] CURL succeeded, calling onComplete" << std::endl;
            if (onComplete) {
                HttpResponse httpResponse;
                httpResponse.content = "success";
                std::cout << "[HttpService] Calling onComplete callback" << std::endl;
                onComplete(httpResponse);
                std::cout << "[HttpService] onComplete callback finished" << std::endl;
            } else {
                std::cout << "[HttpService] Warning: onComplete callback is null" << std::endl;
            }
        }

        // Cleanup
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);

    } catch (const std::exception& e) {
        std::cout << "[HttpService] Exception caught: " << e.what() << std::endl;
        if (headers) {
            curl_slist_free_all(headers);
        }
        curl_easy_cleanup(curl);

        if (onError) {
            onError(AgentError(ErrorType::Network, ErrorCode::NetworkError, e.what()));
        }
    }
    
    std::cout << "[HttpService] sendSseRequest finished" << std::endl;
}

void HttpService::cancelRequest(const std::string& requestId) {
    std::lock_guard<std::mutex> lock(m_cancelMutex);
    auto it = m_cancelFlags.find(requestId);
    if (it != m_cancelFlags.end()) {
        it->second.store(true);
    }
}

void HttpService::setupCurlOptions(CURL* curl, const HttpRequest& request, struct curl_slist** headers) {
    // Set URL
    curl_easy_setopt(curl, CURLOPT_URL, request.url.c_str());

    // Set HTTP method
    switch (request.method) {
        case HttpMethod::GET:
            curl_easy_setopt(curl, CURLOPT_HTTPGET, 1L);
            break;
        case HttpMethod::POST:
            curl_easy_setopt(curl, CURLOPT_POST, 1L);
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request.body.c_str());
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, request.body.length());
            break;
        case HttpMethod::PUT:
            curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request.body.c_str());
            break;
        case HttpMethod::DELETE:
            curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
            break;
        case HttpMethod::PATCH:
            curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PATCH");
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request.body.c_str());
            break;
    }

    // Set request headers
    for (const auto& [key, value] : request.headers) {
        std::string header = key + ": " + value;
        *headers = curl_slist_append(*headers, header.c_str());
    }

    // Set default Content-Type if not specified and body is present
    if (request.headers.find("Content-Type") == request.headers.end() && !request.body.empty()) {
        *headers = curl_slist_append(*headers, "Content-Type: application/json");
    }

    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, *headers);

    // Set timeout
    if (request.timeoutMs > 0) {
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(request.timeoutMs));
    }

    // Set SSL verification (should be enabled in production)
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);

    // Set User-Agent
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "AG-UI-CPP-SDK/1.0");

    // Enable redirect following
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 5L);
}

// Static Callback Functions

size_t HttpService::writeCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    size_t realsize = size * nmemb;
    std::string* str = static_cast<std::string*>(userp);
    str->append(static_cast<char*>(contents), realsize);
    return realsize;
}

size_t HttpService::sseWriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    size_t realsize = size * nmemb;
    auto* context = static_cast<SseCallbackContext*>(userp);

    // Check if cancelled
    if (context->cancelFlag && context->cancelFlag->load()) {
        return 0;  // Returning 0 causes CURL to abort the request
    }

    // Immediately invoke callback with data
    if (context->onData) {
        std::string chunk(static_cast<char*>(contents), realsize);
        HttpResponse httpResponse;
        httpResponse.statusCode = 200;
        httpResponse.content = chunk;
        context->onData(httpResponse);
    }

    return realsize;
}

bool HttpService::parseUrl(const std::string& url, std::string& scheme, std::string& host, int& port,
                               std::string& path) {
    // Simplified URL parsing
    size_t schemeEnd = url.find("://");
    if (schemeEnd == std::string::npos) {
        return false;
    }

    scheme = url.substr(0, schemeEnd);

    size_t hostStart = schemeEnd + 3;
    size_t pathStart = url.find('/', hostStart);

    if (pathStart == std::string::npos) {
        host = url.substr(hostStart);
        path = "/";
    } else {
        host = url.substr(hostStart, pathStart - hostStart);
        path = url.substr(pathStart);
    }

    // Parse port
    size_t portStart = host.find(':');
    if (portStart != std::string::npos) {
        std::string portStr = host.substr(portStart + 1);
        host = host.substr(0, portStart);
        port = std::stoi(portStr);
    } else {
        port = (scheme == "https") ? 443 : 80;
    }

    return true;
}

}  // namespace agui
