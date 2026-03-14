#pragma once

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <string>

#include "core/error.h"

// Forward declaration
typedef void CURL;
struct curl_slist;

namespace agui {

struct HttpResponse {
    int statusCode;
    std::string body;
    std::string content;
    std::map<std::string, std::string> headers;

    HttpResponse() : statusCode(0) {}

    HttpResponse(int code, const std::string& b) : statusCode(code), body(b) {}

    bool isSuccess() const { return statusCode >= 200 && statusCode < 300; }
};

enum class HttpMethod { GET, POST, PUT, DELETE, PATCH };

struct HttpRequest {
    HttpMethod method;
    std::string url;
    std::map<std::string, std::string> headers;
    std::string body;
    int timeoutMs;

    HttpRequest() : method(HttpMethod::GET), timeoutMs(30000) {}
};


using HttpResponseCallback = std::function<void(const HttpResponse& response)>;
using HttpErrorCallback = std::function<void(const AgentError& error)>;
using SseDataCallback = std::function<void(const HttpResponse& data)>;
using SseCompleteCallback = std::function<void(const HttpResponse& data)>;

class IHttpService {
public:
    virtual ~IHttpService() = default;

    virtual void sendRequest(const HttpRequest& request, HttpResponseCallback onResponse,
                             HttpErrorCallback onError) = 0;

    virtual void sendSseRequest(const HttpRequest& request, SseDataCallback sseDataCallbackFunc,
                                SseCompleteCallback completeCallbackFunc, HttpErrorCallback errorCallbackFunc) = 0;

    virtual void cancelRequest(const std::string& requestUrl) {}
};

class HttpServiceFactory {
public:
    static std::unique_ptr<IHttpService> createCurlService();
};
/**
 * @brief HTTP service implementation using libcurl
 *
 * Features:
 * - Real HTTP requests
 * - SSE streaming
 * - Error handling
 * - Request cancellation
 */
class HttpService : public IHttpService {
public:
    HttpService();
    ~HttpService() override;

    /**
     * @brief Send HTTP request
     */
    void sendRequest(const HttpRequest& request, HttpResponseCallback onResponse,
                     HttpErrorCallback onError) override;

    /**
     * @brief Send SSE streaming request
     */
    void sendSseRequest(const HttpRequest& request, SseDataCallback sseDataCallbackFunc,
                        SseCompleteCallback completeCallbackFunc, HttpErrorCallback errorCallbackFunc) override;

    /**
     * @brief Cancel request
     */
    void cancelRequest(const std::string& requestUrl) override;

private:
    /**
     * @brief Setup common CURL options
     */
    void setupCurlOptions(CURL* curl, const HttpRequest& request, struct curl_slist** headers);

    /**
     * @brief libcurl write callback for regular HTTP requests
     */
    static size_t writeCallback(void* contents, size_t size, size_t nmemb, void* userp);

    /**
     * @brief libcurl write callback for SSE streaming requests
     */
    static size_t sseWriteCallback(void* contents, size_t size, size_t nmemb, void* userp);

    /**
     * @brief libcurl header callback for SSE streaming requests
     * Extracts HTTP status code from response status line
     */
    static size_t sseHeaderCallback(char* buffer, size_t size, size_t nitems, void* userdata);

    // Each SSE request registers a shared_ptr<atomic<bool>> here so that
    // cancelRequest() and the libcurl write callback share the exact same flag object.
    std::map<std::string, std::shared_ptr<std::atomic<bool>>> m_cancelFlags;
    std::mutex m_cancelMutex;
};

/**
 * @brief Context for SSE streaming callbacks
 *
 * @note Thread-safety model:
 * - `httpStatusCode` and `abortedDueToHttpError` are plain (non-atomic) types.
 *   Both are accessed only within curl_easy_perform():
 *   sseHeaderCallback writes httpStatusCode before sseWriteCallback reads it.
 *   And sseWriteCallback writes abortedDueToHttpError before sendSseRequest() reads it after
 *   curl_easy_perform() returns.
 *   The libcurl easy interface guarantees all callbacks run sequentially on the calling thread.
 * - `cancelFlag` is intentionally `std::atomic<bool>*` because cancelRequest()
 *   may be called from a different thread to interrupt an in-flight request.
 * - NOTE: This module is documented as single-threaded. Applications with different concurrency requirements
 *   should adapt the threading model accordingly before use.
 */
struct SseCallbackContext {
    SseDataCallback onData;
    std::atomic<bool>* cancelFlag;  ///< Shared with cancelRequest(); must be atomic (cross-thread write).
    int httpStatusCode;             ///< Written by sseHeaderCallback, read by sseWriteCallback (same thread).
    bool abortedDueToHttpError;     ///< Written by sseWriteCallback, read after curl_easy_perform() (same thread).

    SseCallbackContext(SseDataCallback callback, std::atomic<bool>* flag)
        : onData(std::move(callback)), cancelFlag(flag),
          httpStatusCode(0), abortedDueToHttpError(false) {}
};

}  // namespace agui
