#pragma once

#include <atomic>
#include <cstdint>
#include <string>

namespace agui {

/**
 * @brief UUID generator
 *
 * Generates UUID v4 format strings using timestamp + random number + counter
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 *
 * Thread-safe
 */
class UuidGenerator {
public:
    /**
     * @brief Generate a new UUID
     * @return UUID string
     */
    static std::string generate();

private:
    /**
     * @brief Get current timestamp in milliseconds
     * @return Timestamp
     */
    static uint64_t getTimestamp();

    /**
     * @brief Get random number
     * @return Random number
     */
    static uint32_t getRandomNumber();

    /**
     * @brief Global counter (thread-safe)
     */
    static std::atomic<uint32_t> _counter;
};

}  // namespace agui
