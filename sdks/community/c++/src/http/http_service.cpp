#include "http/http_service.h"
#include <iostream>
#include <mutex>
#include <thread>
#include <curl/curl.h>
#include "core/logger.h"

namespace agui {

static std::once_flag s_curlInitFlag;
std::unique_ptr<IHttpService> HttpServiceFactory::createCurlService() {
    return std::make_unique<HttpService>();
}

HttpService::HttpService() {
    std::call_once(s_curlInitFlag, []() {
        curl_global_init(CURL_GLOBAL_DEFAULT);
    });
}

HttpService::~HttpService() {
    // Note: Do not call curl_global_cleanup() here as there may be multiple instances
}

void HttpService::sendRequest(const HttpRequest& request, HttpResponseCallback responseCallbackFunc,
                                  HttpErrorCallback errorCallbackFunc) {
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

        // Call success callback
        if (responseCallbackFunc) {
            responseCallbackFunc(response);
        }

    } catch (const std::exception& e) {
        if (headers) {
            curl_slist_free_all(headers);
        }
        curl_easy_cleanup(curl);
        
        // Call error callback
        if (errorCallbackFunc) {
            errorCallbackFunc(AgentError(ErrorType::Network, ErrorCode::NetworkError, e.what()));
        }
    }
}

void HttpService::sendSseRequest(const HttpRequest& request, SseDataCallback sseDataCallbackFunc,
                                    SseCompleteCallback completeCallbackFunc, HttpErrorCallback errorCallbackFunc) {
    // Network requests should be executed in a separate thread to avoid blocking
    CURL* curl = curl_easy_init();
    if (!curl) {
        Logger::debugf("[HttpService] Failed to initialize CURL");
        if (errorCallbackFunc) {
            errorCallbackFunc(AgentError(ErrorType::Network, ErrorCode::NetworkError, "Failed to initialize CURL"));
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

        // Create a shared cancel flag so that cancelRequest() and the libcurl
        // write callback operate on the same atomic object.
        auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
        {
            std::lock_guard<std::mutex> lock(m_cancelMutex);
            m_cancelFlags[request.url] = cancelFlag;
        }

        // Set streaming callback (pass curl handle for status code access)
        SseCallbackContext context(sseDataCallbackFunc, cancelFlag.get(), curl);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, sseWriteCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &context);

        // Set header callback for HTTP status code extraction
        curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, sseHeaderCallback);
        curl_easy_setopt(curl, CURLOPT_HEADERDATA, &context);

        // Execute request
        CURLcode res = curl_easy_perform(curl);

        // Get actual HTTP response code (valid even after CURLE_WRITE_ERROR)
        long responseCode = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &responseCode);

        // Cleanup cancel flag
        {
            std::lock_guard<std::mutex> lock(m_cancelMutex);
            m_cancelFlags.erase(request.url);
        }

        if (res == CURLE_OK) {
            if (responseCode >= 200 && responseCode < 300) {
                // Success: server returned 2xx
                if (completeCallbackFunc) {
                    HttpResponse httpResponse;
                    httpResponse.statusCode = static_cast<int>(responseCode);
                    httpResponse.content = "success";
                    Logger::debugf("[HttpService] Calling onComplete callback, status: ", responseCode);
                    completeCallbackFunc(httpResponse);
                }
            } else {
                // Server returned non-2xx but curl completed normally
                // (can happen for small error responses that transfer completely)
                std::string errorMsg = "HTTP error: server returned status " + std::to_string(responseCode);
                Logger::errorf("[HttpService] ", errorMsg);
                if (errorCallbackFunc) {
                    errorCallbackFunc(AgentError(ErrorType::Network, ErrorCode::NetworkInvalidResponse, errorMsg));
                }
            }
        } else if (res == CURLE_WRITE_ERROR) {
            // Write callback returned 0 — distinguish between HTTP error abort and user cancel
            if (context.abortedDueToHttpError) {
                // Aborted because sseWriteCallback detected non-2xx status
                std::string errorMsg = "HTTP error: server returned status " + std::to_string(responseCode);
                Logger::errorf("[HttpService] ", errorMsg);
                if (errorCallbackFunc) {
                    errorCallbackFunc(AgentError(ErrorType::Network, ErrorCode::NetworkInvalidResponse, errorMsg));
                }
            } else if (context.cancelFlag && context.cancelFlag->load()) {
                // User cancelled the request
                Logger::debugf("[HttpService] SSE request was cancelled by user");
            } else {
                // Unknown write error
                std::string errorMsg = "CURL write error: ";
                errorMsg += curl_easy_strerror(res);
                Logger::errorf("[HttpService] ", errorMsg);
                if (errorCallbackFunc) {
                    errorCallbackFunc(AgentError(ErrorType::Network, ErrorCode::NetworkError, errorMsg));
                }
            }
        } else {
            // Other CURL errors (connection failure, timeout, SSL error, etc.)
            std::string errorMsg = "CURL error: ";
            errorMsg += curl_easy_strerror(res);
            Logger::errorf("[HttpService] ", errorMsg);
            if (errorCallbackFunc) {
                errorCallbackFunc(AgentError(ErrorType::Network, ErrorCode::NetworkError, errorMsg));
            }
        }

        // Cleanup
        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);

    } catch (const std::exception& e) {
        Logger::debugf("[HttpService] Exception caught: %s", e.what());
        if (headers) {
            curl_slist_free_all(headers);
        }
        curl_easy_cleanup(curl);

        if (errorCallbackFunc) {
            errorCallbackFunc(AgentError(ErrorType::Network, ErrorCode::NetworkError, e.what()));
        }
    }
    
    Logger::debugf("[HttpService] sendSseRequest finished");
}

void HttpService::cancelRequest(const std::string& requestUrl) {
    std::lock_guard<std::mutex> lock(m_cancelMutex);
    auto it = m_cancelFlags.find(requestUrl);
    if (it != m_cancelFlags.end()) {
        it->second->store(true);  // dereference shared_ptr, then set the shared atomic flag
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

    // Check HTTP status code — abort if non-2xx to prevent feeding error body to SSE parser
    int statusCode = context->httpStatusCode;
    if (statusCode > 0 && (statusCode < 200 || statusCode >= 300)) {
        context->abortedDueToHttpError = true;
        Logger::errorf("[HttpService] SSE received non-2xx status: ", statusCode, ", aborting stream");
        return 0;  // Abort transfer for non-2xx responses
    }

    // Immediately invoke callback with actual status code
    if (context->onData) {
        std::string chunk(static_cast<char*>(contents), realsize);
        HttpResponse httpResponse;
        httpResponse.statusCode = statusCode > 0 ? statusCode : 0;
        httpResponse.content = chunk;
        context->onData(httpResponse);
    }

    return realsize;
}

size_t HttpService::sseHeaderCallback(char* buffer, size_t size, size_t nitems, void* userdata) {
    size_t realsize = size * nitems;
    auto* context = static_cast<SseCallbackContext*>(userdata);

    // Parse HTTP status line: "HTTP/x.x NNN reason\r\n"
    // With CURLOPT_FOLLOWLOCATION enabled, this may be called multiple times for redirects.
    // Each new "HTTP/" status line overwrites the previous one, so the final value is correct.
    std::string headerLine(buffer, realsize);
    if (headerLine.compare(0, 5, "HTTP/") == 0) {
        size_t spacePos = headerLine.find(' ');
        if (spacePos != std::string::npos && spacePos + 3 <= headerLine.size()) {
            try {
                context->httpStatusCode = std::stoi(headerLine.substr(spacePos + 1, 3));
                Logger::debugf("[HttpService] SSE HTTP status code: ", context->httpStatusCode);
            } catch (...) {
                // Failed to parse status code, keep previous value
            }
        }
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
