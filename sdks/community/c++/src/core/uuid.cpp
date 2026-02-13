#include "uuid.h"

#include <chrono>
#include <cstdio>
#include <random>

namespace agui {

// Initialize static member
std::atomic<uint32_t> UuidGenerator::_counter(0);

// Global random number generator
static std::mt19937& getGenerator() {
    static std::random_device rd;
    static std::mt19937 generator(rd());
    return generator;
}

uint64_t UuidGenerator::getTimestamp() {
    auto now = std::chrono::system_clock::now();
    auto duration = now.time_since_epoch();
    auto millis = std::chrono::duration_cast<std::chrono::milliseconds>(duration).count();
    return static_cast<uint64_t>(millis);
}

uint32_t UuidGenerator::getRandomNumber() {
    std::uniform_int_distribution<uint32_t> distribution(0, 0xFFFFFFFF);
    return distribution(getGenerator());
}

std::string UuidGenerator::generate() {
    uint64_t timestamp = getTimestamp();
    uint32_t random = getRandomNumber();
    uint32_t count = _counter.fetch_add(1);

    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    // - 13th character is fixed to '4' (version)
    // - 17th character's high 2 bits are fixed to '10' (variant)

    char uuid[37];
    snprintf(uuid, sizeof(uuid), "%08x-%04x-4%03x-%04x-%08x%04x",
             static_cast<uint32_t>(timestamp & 0xFFFFFFFF),
             static_cast<uint16_t>((timestamp >> 32) & 0xFFFF),
             static_cast<uint16_t>(random & 0x0FFF),
             static_cast<uint16_t>(0x8000 | ((random >> 12) & 0x3FFF)),
             count,
             static_cast<uint32_t>(random >> 16)
    );

    return std::string(uuid);
}

}  // namespace agui
