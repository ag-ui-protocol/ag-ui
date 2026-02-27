#pragma once

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

    virtual void sendSseRequest(const HttpRequest& request, SseDataCallback onData, SseCompleteCallback onComplete,
                                HttpErrorCallback onError) = 0;

    virtual void cancelRequest(const std::string& requestId) {}
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
    void sendSseRequest(const HttpRequest& request, SseDataCallback onData, SseCompleteCallback onComplete,
                        HttpErrorCallback onError) override;

    /**
     * @brief Cancel request
     */
    void cancelRequest(const std::string& requestId) override;

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
     * @brief Parse URL
     */
    static bool parseUrl(const std::string& url, std::string& scheme, std::string& host, int& port,
                         std::string& path);

    // Request cancellation management
    std::map<std::string, std::atomic<bool>> m_cancelFlags;
    std::mutex m_cancelMutex;
};

/**
 * @brief Context for SSE streaming callbacks
 */
struct SseCallbackContext {
    SseDataCallback onData;
    std::atomic<bool>* cancelFlag;

    SseCallbackContext(SseDataCallback callback, std::atomic<bool>* flag)
        : onData(std::move(callback)), cancelFlag(flag) {}
};

}  // namespace agui
