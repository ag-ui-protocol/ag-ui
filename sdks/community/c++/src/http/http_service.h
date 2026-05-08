#pragma once

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>

#include "core/error.h"

// Forward declaration
typedef void CURL;
struct curl_slist;

namespace agui {

struct HttpResponse {
    int statusCode = 0;
    std::string content;
    std::map<std::string, std::string> headers;
    bool cancelled = false;  ///< true when the request was cancelled via cancelRequest()

    bool isSuccess() const { return statusCode >= 200 && statusCode < 300; }
};

enum class HttpMethod { GET, POST, PUT, DELETE, PATCH };

struct HttpRequest {
    HttpMethod method;
    std::string url;
    std::string cancelKey;
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

    virtual void cancelRequest(const std::string& requestKey) {}
};

class HttpServiceFactory {
public:
    static std::unique_ptr<IHttpService> createCurlService();
};
class HttpService : public IHttpService {
public:
    HttpService();
    ~HttpService() override;

    void sendRequest(const HttpRequest& request, HttpResponseCallback onResponse,
                     HttpErrorCallback onError) override;

    void sendSseRequest(const HttpRequest& request, SseDataCallback sseDataCallbackFunc,
                        SseCompleteCallback completeCallbackFunc, HttpErrorCallback errorCallbackFunc) override;

    void cancelRequest(const std::string& requestKey) override;

private:
    void setupCurlOptions(CURL* curl, const HttpRequest& request, struct curl_slist** headers);
    static size_t writeCallback(void* contents, size_t size, size_t nmemb, void* userp);
    static size_t sseWriteCallback(void* contents, size_t size, size_t nmemb, void* userp);
    // Extracts HTTP status code from the response status line.
    static size_t sseHeaderCallback(char* buffer, size_t size, size_t nitems, void* userdata);

    void registerCancelFlag(const std::string& key, const std::shared_ptr<std::atomic<bool>>& flag);
    void unregisterCancelFlag(const std::string& key, const std::shared_ptr<std::atomic<bool>>& flag);

    // Each SSE request registers the same cancel flag under its URL and, optionally,
    // an explicit cancelKey. A multimap avoids overwriting concurrent requests that
    // target the same URL.
    std::multimap<std::string, std::shared_ptr<std::atomic<bool>>> m_cancelFlags;
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
    bool abortedDueToCallbackException;  ///< Written by sseWriteCallback, read after curl_easy_perform().
    std::string errorBody;          ///< Server error response body collected on non-2xx (max 8 KiB).
    std::string callbackExceptionMessage;  ///< Captures the callback failure that aborted the stream.

    SseCallbackContext(SseDataCallback callback, std::atomic<bool>* flag)
        : onData(std::move(callback)), cancelFlag(flag),
          httpStatusCode(0), abortedDueToHttpError(false), abortedDueToCallbackException(false) {}
};

}  // namespace agui
