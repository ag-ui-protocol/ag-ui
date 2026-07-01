#pragma once

#include <atomic>
#include <cstdint>
#include <string>

namespace agui {

/**
 * @brief UUID generator
 *
 * Generates RFC 4122 v4 UUIDs using 122 cryptographically-random bits.
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 *
 * Thread-safe: uses a thread-local Mersenne Twister seeded from std::random_device.
 */
class UuidGenerator {
public:
    /**
     * @brief Generate a new RFC 4122 v4 UUID
     * @return UUID string
     */
    static std::string generate();
};

}  // namespace agui
