#include "http/http_service.h"
#include <curl/curl.h>
#include "core/logger.h"

namespace agui {

static std::once_flag s_curlInitFlag;
static std::string s_curlInitError;

std::unique_ptr<IHttpService> HttpServiceFactory::createCurlService() {
    return std::make_unique<HttpService>();
}

// Macro to check curl_easy_setopt return values.
// A silent failure leaves libcurl in a default/wrong state (wrong URL, wrong method,
// missing headers, etc.) that is extremely hard to debug. Fail loudly instead.
#define CURL_CHECK_SETOPT(curl, opt, val)                                            \
    do {                                                                              \
        CURLcode _setopt_res = curl_easy_setopt((curl), (opt), (val));               \
        if (_setopt_res != CURLE_OK) {                                                \
            throw std::runtime_error(std::string("curl_easy_setopt(" #opt ") failed: ") + \
                                     curl_easy_strerror(_setopt_res));                \
        }                                                                             \
    } while (0)

namespace {

void unregisterCancelFlagFromMap(
    std::multimap<std::string, std::shared_ptr<std::atomic<bool>>>& cancelFlags,
    const std::string& key,
    const std::shared_ptr<std::atomic<bool>>& flag) {
    auto range = cancelFlags.equal_range(key);
    for (auto it = range.first; it != range.second; ) {
        if (it->second == flag) {
            it = cancelFlags.erase(it);
        } else {
            ++it;
        }
    }
}

// Append a header string to a curl_slist.
// curl_slist_append returns NULL on OOM, which would silently lose all previously
// appended headers and leak the existing list. Throw immediately instead.
struct curl_slist* appendCurlHeader(struct curl_slist* list, const char* header) {
    struct curl_slist* newList = curl_slist_append(list, header);
    if (!newList) {
        curl_slist_free_all(list);  // release existing nodes before throwing
        throw std::bad_alloc();
    }
    return newList;
}

}  // namespace

HttpService::HttpService() {
    // curl_global_init must not be retried on failure; record the error once and throw on every
    // subsequent construction attempt instead.
    std::call_once(s_curlInitFlag, []() {
        CURLcode res = curl_global_init(CURL_GLOBAL_DEFAULT);
        if (res != CURLE_OK) {
            s_curlInitError = std::string("curl_global_init failed: ") + curl_easy_strerror(res);
        }
    });
    if (!s_curlInitError.empty()) {
        throw AgentError(ErrorType::Network, ErrorCode::NetworkConnectionFailed, s_curlInitError);
    }
}

HttpService::~HttpService() {
    // Note: Do not call curl_global_cleanup() here as there may be multiple instances
}

void HttpService::sendRequest(const HttpRequest& request, HttpResponseCallback responseCallbackFunc,
                                  HttpErrorCallback errorCallbackFunc) {
    // Blocking call: returns only after the full response is received.
    // The caller is responsible for running this on a worker thread if needed.
    CURL* curl = curl_easy_init();
    if (!curl) {
        throw std::runtime_error("Failed to initialize CURL");
    }

    HttpResponse response;
    struct curl_slist* headers = nullptr;

    try {
        // Set common options
        setupCurlOptions(curl, request, &headers);

        std::string responseBody;
        CURLcode wfRes = curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
        if (wfRes != CURLE_OK) {
            throw std::runtime_error(std::string("curl_easy_setopt(WRITEFUNCTION) failed: ") +
                                     curl_easy_strerror(wfRes));
        }
        CURLcode wdRes = curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseBody);
        if (wdRes != CURLE_OK) {
            throw std::runtime_error(std::string("curl_easy_setopt(WRITEDATA) failed: ") +
                                     curl_easy_strerror(wdRes));
        }

        // Execute request
        CURLcode res = curl_easy_perform(curl);

        if (res != CURLE_OK) {
            std::string errorMsg = "CURL error: ";
            errorMsg += curl_easy_strerror(res);
            throw std::runtime_error(errorMsg);
        }

        long statusCode = 0;  // initialized to 0; check getinfo return to avoid UB on failure
        CURLcode infoRes = curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &statusCode);
        if (infoRes != CURLE_OK) {
            throw std::runtime_error(std::string("curl_easy_getinfo(RESPONSE_CODE) failed: ") +
                                     curl_easy_strerror(infoRes));
        }

        response.statusCode = static_cast<int>(statusCode);
        response.content = responseBody;

        // Get actual Content-Type from server response
        char* contentType = nullptr;
        CURLcode ctRes = curl_easy_getinfo(curl, CURLINFO_CONTENT_TYPE, &contentType);
        if (ctRes != CURLE_OK) {
            // Non-fatal: Content-Type is informational; log and continue.
            Logger::warningf("curl_easy_getinfo(CONTENT_TYPE) failed: ", curl_easy_strerror(ctRes));
        } else if (contentType) {
            response.headers["Content-Type"] = contentType;
        }

        // Cleanup before invoking callback to avoid double-free if callback throws.
        curl_slist_free_all(headers);
        headers = nullptr;
        curl_easy_cleanup(curl);
        curl = nullptr;

    } catch (const std::exception& e) {
        if (headers) {
            curl_slist_free_all(headers);
            headers = nullptr;
        }
        if (curl) {
            curl_easy_cleanup(curl);
            curl = nullptr;
        }

        Logger::errorf("[HttpService] sendRequest failed: ", e.what());
        if (errorCallbackFunc) {
            errorCallbackFunc(AgentError(ErrorType::Network, ErrorCode::NetworkError, e.what()));
        }
        return;
    }

    // Outside try-catch: business logic exceptions must not be wrapped as NetworkError.
    if (responseCallbackFunc) {
        responseCallbackFunc(response);
    }
}

void HttpService::sendSseRequest(const HttpRequest& request, SseDataCallback sseDataCallbackFunc,
                                    SseCompleteCallback completeCallbackFunc, HttpErrorCallback errorCallbackFunc) {
    // Blocking call: streams SSE data synchronously until the connection closes.
    // The caller is responsible for running this on a worker thread if needed.
    CURL* curl = curl_easy_init();
    if (!curl) {
        Logger::errorf("[HttpService] Failed to initialize CURL");
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
        CURL_CHECK_SETOPT(curl, CURLOPT_TIMEOUT_MS, 0L);

        // 2. Set connection timeout from request (falls back to 30s if not set)
        long connectTimeoutMs = request.timeoutMs > 0 ? static_cast<long>(request.timeoutMs) : 30000L;
        CURL_CHECK_SETOPT(curl, CURLOPT_CONNECTTIMEOUT_MS, connectTimeoutMs);

        // 3. Set low-speed timeout to detect network failures
        CURL_CHECK_SETOPT(curl, CURLOPT_LOW_SPEED_TIME, 60L);
        CURL_CHECK_SETOPT(curl, CURLOPT_LOW_SPEED_LIMIT, 1L);

        // 4. Enable TCP keep-alive to detect dead connections
        CURL_CHECK_SETOPT(curl, CURLOPT_TCP_KEEPALIVE, 1L);
        CURL_CHECK_SETOPT(curl, CURLOPT_TCP_KEEPIDLE, 120L);
        CURL_CHECK_SETOPT(curl, CURLOPT_TCP_KEEPINTVL, 60L);

        // 5. Add SSE-specific headers — use appendCurlHeader to detect OOM immediately.
        headers = appendCurlHeader(headers, "Accept: text/event-stream");
        headers = appendCurlHeader(headers, "Cache-Control: no-cache");
        headers = appendCurlHeader(headers, "Connection: keep-alive");
        CURL_CHECK_SETOPT(curl, CURLOPT_HTTPHEADER, headers);

        // Create a shared cancel flag so that cancelRequest() and the libcurl
        // write callback operate on the same atomic object.
        auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
        {
            std::lock_guard<std::mutex> lock(m_cancelMutex);
            registerCancelFlag(request.url, cancelFlag);
            if (!request.cancelKey.empty() && request.cancelKey != request.url) {
                registerCancelFlag(request.cancelKey, cancelFlag);
            }
        }

        SseCallbackContext context(sseDataCallbackFunc, cancelFlag.get());
        CURLcode sseWfRes = curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, sseWriteCallback);
        if (sseWfRes != CURLE_OK) {
            throw std::runtime_error(std::string("curl_easy_setopt(WRITEFUNCTION) failed: ") +
                                     curl_easy_strerror(sseWfRes));
        }
        CURLcode sseWdRes = curl_easy_setopt(curl, CURLOPT_WRITEDATA, &context);
        if (sseWdRes != CURLE_OK) {
            throw std::runtime_error(std::string("curl_easy_setopt(WRITEDATA) failed: ") +
                                     curl_easy_strerror(sseWdRes));
        }

        // Set header callback for HTTP status code extraction
        CURLcode hfRes = curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, sseHeaderCallback);
        if (hfRes != CURLE_OK) {
            throw std::runtime_error(std::string("curl_easy_setopt(HEADERFUNCTION) failed: ") +
                                     curl_easy_strerror(hfRes));
        }
        CURLcode hdRes = curl_easy_setopt(curl, CURLOPT_HEADERDATA, &context);
        if (hdRes != CURLE_OK) {
            throw std::runtime_error(std::string("curl_easy_setopt(HEADERDATA) failed: ") +
                                     curl_easy_strerror(hdRes));
        }

        // Execute request
        CURLcode res = curl_easy_perform(curl);

        // responseCode stays 0 on getinfo failure, triggering the error path below.
        long responseCode = 0;
        CURLcode rcRes = curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &responseCode);
        if (rcRes != CURLE_OK) {
            Logger::errorf("[HttpService] curl_easy_getinfo(RESPONSE_CODE) failed: ",
                           curl_easy_strerror(rcRes));
        }

        // Cleanup cancel flag
        {
            std::lock_guard<std::mutex> lock(m_cancelMutex);
            unregisterCancelFlag(request.url, cancelFlag);
            if (!request.cancelKey.empty() && request.cancelKey != request.url) {
                unregisterCancelFlag(request.cancelKey, cancelFlag);
            }
        }

        if (res == CURLE_OK) {
            if (responseCode >= 200 && responseCode < 300) {
                if (completeCallbackFunc) {
                    HttpResponse httpResponse;
                    httpResponse.statusCode = static_cast<int>(responseCode);
                    // content is empty: SSE data was already delivered incrementally via onData.
                    Logger::debugf("[HttpService] Calling onComplete callback, status: ", responseCode);
                    completeCallbackFunc(httpResponse);
                }
            } else {
                std::string errorMsg = "HTTP error: server returned status " + std::to_string(responseCode);
                if (!context.errorBody.empty()) {
                    errorMsg += ": " + context.errorBody;
                }
                Logger::errorf("[HttpService] ", errorMsg);
                if (errorCallbackFunc) {
                    errorCallbackFunc(AgentError(ErrorType::Network, ErrorCode::NetworkInvalidResponse, errorMsg));
                }
            }
        } else if (res == CURLE_WRITE_ERROR) {
            // Write callback returned 0 — distinguish between callback error, HTTP error, and user cancel
            if (context.abortedDueToCallbackException) {
                std::string errorMsg = "SSE data callback failed";
                if (!context.callbackExceptionMessage.empty()) {
                    errorMsg += ": " + context.callbackExceptionMessage;
                }
                Logger::errorf("[HttpService] ", errorMsg);
                if (errorCallbackFunc) {
                    errorCallbackFunc(
                        AgentError(ErrorType::Execution, ErrorCode::ExecutionAgentFailed, errorMsg));
                }
            } else if (context.abortedDueToHttpError) {
                // Aborted because sseWriteCallback detected non-2xx status
                std::string errorMsg = "HTTP error: server returned status " + std::to_string(responseCode);
                if (!context.errorBody.empty()) {
                    errorMsg += ": " + context.errorBody;
                }
                Logger::errorf("[HttpService] ", errorMsg);
                if (errorCallbackFunc) {
                    errorCallbackFunc(AgentError(ErrorType::Network, ErrorCode::NetworkInvalidResponse, errorMsg));
                }
            } else if (context.cancelFlag && context.cancelFlag->load()) {
                // User cancelled the request — notify upper layer so it can clean up subscribers
                Logger::debugf("[HttpService] SSE request was cancelled by user");
                if (completeCallbackFunc) {
                    HttpResponse cancelledResponse;
                    cancelledResponse.cancelled = true;
                    completeCallbackFunc(cancelledResponse);
                }
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

        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);

    } catch (const std::exception& e) {
        Logger::errorf("[HttpService] Exception caught: ", e.what());
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

void HttpService::registerCancelFlag(const std::string& key, const std::shared_ptr<std::atomic<bool>>& flag) {
    m_cancelFlags.emplace(key, flag);
}

void HttpService::unregisterCancelFlag(const std::string& key, const std::shared_ptr<std::atomic<bool>>& flag) {
    unregisterCancelFlagFromMap(m_cancelFlags, key, flag);
}

void HttpService::cancelRequest(const std::string& requestKey) {
    std::lock_guard<std::mutex> lock(m_cancelMutex);
    auto range = m_cancelFlags.equal_range(requestKey);
    for (auto it = range.first; it != range.second; ++it) {
        it->second->store(true);
    }
}

void HttpService::setupCurlOptions(CURL* curl, const HttpRequest& request, struct curl_slist** headers) {
    CURL_CHECK_SETOPT(curl, CURLOPT_URL, request.url.c_str());

    // Set HTTP method
    switch (request.method) {
        case HttpMethod::GET:
            CURL_CHECK_SETOPT(curl, CURLOPT_HTTPGET, 1L);
            break;
        case HttpMethod::POST:
            CURL_CHECK_SETOPT(curl, CURLOPT_POST, 1L);
            CURL_CHECK_SETOPT(curl, CURLOPT_POSTFIELDS, request.body.c_str());
            CURL_CHECK_SETOPT(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(request.body.length()));
            break;
        case HttpMethod::PUT:
            CURL_CHECK_SETOPT(curl, CURLOPT_CUSTOMREQUEST, "PUT");
            CURL_CHECK_SETOPT(curl, CURLOPT_POSTFIELDS, request.body.c_str());
            break;
        case HttpMethod::DELETE:
            CURL_CHECK_SETOPT(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
            break;
        case HttpMethod::PATCH:
            CURL_CHECK_SETOPT(curl, CURLOPT_CUSTOMREQUEST, "PATCH");
            CURL_CHECK_SETOPT(curl, CURLOPT_POSTFIELDS, request.body.c_str());
            break;
    }

    for (const auto& [key, value] : request.headers) {
        std::string header = key + ": " + value;
        *headers = appendCurlHeader(*headers, header.c_str());
    }

    if (request.headers.find("Content-Type") == request.headers.end() && !request.body.empty()) {
        *headers = appendCurlHeader(*headers, "Content-Type: application/json");
    }

    CURL_CHECK_SETOPT(curl, CURLOPT_HTTPHEADER, *headers);

    if (request.timeoutMs > 0) {
        CURL_CHECK_SETOPT(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(request.timeoutMs));
    }

    CURL_CHECK_SETOPT(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    CURL_CHECK_SETOPT(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    CURL_CHECK_SETOPT(curl, CURLOPT_USERAGENT, "AG-UI-CPP-SDK/1.0");
    CURL_CHECK_SETOPT(curl, CURLOPT_FOLLOWLOCATION, 1L);
    CURL_CHECK_SETOPT(curl, CURLOPT_MAXREDIRS, 5L);
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

    if (context->cancelFlag && context->cancelFlag->load()) {
        return 0;  // Returning 0 causes CURL to abort
    }

    // Collect error body and abort for non-2xx (or -1: malformed header line)
    // to prevent feeding the error response to the SSE parser.
    int statusCode = context->httpStatusCode;
    if (statusCode != 0 && (statusCode < 200 || statusCode >= 300)) {
        // Collect up to 8 KiB of server error body for diagnostics
        static constexpr size_t kMaxErrorBodySize = 8192;
        if (context->errorBody.size() < kMaxErrorBodySize) {
            size_t remaining = kMaxErrorBodySize - context->errorBody.size();
            context->errorBody.append(static_cast<char*>(contents),
                                      realsize < remaining ? realsize : remaining);
        }
        context->abortedDueToHttpError = true;
        Logger::errorf("[HttpService] SSE received non-2xx status: ", statusCode, ", aborting stream");
        return 0;  // Abort transfer for non-2xx responses
    }

    if (context->onData) {
        std::string chunk(static_cast<char*>(contents), realsize);
        HttpResponse httpResponse;
        httpResponse.statusCode = statusCode > 0 ? statusCode : 0;
        httpResponse.content = chunk;
        try {
            context->onData(httpResponse);
        } catch (const AgentError& error) {
            context->abortedDueToCallbackException = true;
            context->callbackExceptionMessage = error.message();
            Logger::errorf("[HttpService] SSE data callback threw AgentError: ", error.message());
            return 0;
        } catch (const std::exception& error) {
            context->abortedDueToCallbackException = true;
            context->callbackExceptionMessage = error.what();
            Logger::errorf("[HttpService] SSE data callback threw std::exception: ", error.what());
            return 0;
        } catch (...) {
            context->abortedDueToCallbackException = true;
            context->callbackExceptionMessage = "unknown exception";
            Logger::errorf("[HttpService] SSE data callback threw an unknown exception");
            return 0;
        }
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
            } catch (const std::invalid_argument&) {
                Logger::errorf("[HttpService] Failed to parse HTTP status code from header: ", headerLine);
                // set to -1, triggers error path in sseWriteCallback
                context->httpStatusCode = -1;
            } catch (const std::out_of_range&) {
                Logger::errorf("[HttpService] HTTP status code out of range in header: ", headerLine);
                context->httpStatusCode = -1;
            }
        }
    }

    return realsize;
}

}  // namespace agui
