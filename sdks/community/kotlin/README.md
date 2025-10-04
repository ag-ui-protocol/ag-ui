# AG-UI Kotlin SDK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Kotlin](https://img.shields.io/badge/kotlin-2.1.21-blue.svg?logo=kotlin)](http://kotlinlang.org)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20iOS%20%7C%20JVM-lightgrey)](https://kotlinlang.org/docs/multiplatform.html)
[![API](https://img.shields.io/badge/API-26%2B-brightgreen.svg?style=flat)](https://android-arsenal.com/api?level=26)

A production-ready Kotlin Multiplatform client library for connecting applications to AI agents that implement the [Agent User Interaction Protocol (AG-UI)](https://docs.ag-ui.com/).

## 📚 Documentation

**[📖 Complete SDK Documentation](../../../docs/sdk/kotlin/)**

The comprehensive documentation covers:
- [Getting Started](../../../docs/sdk/kotlin/overview.mdx) - Installation and quick start
- [Client APIs](../../../docs/sdk/kotlin/client/) - AgUiAgent, StatefulAgUiAgent, builders
- [Core Types](../../../docs/sdk/kotlin/core/) - Protocol messages, events, and types  
- [Tools Framework](../../../docs/sdk/kotlin/tools/) - Extensible tool execution system

## 🚀 Quick Start

```kotlin
dependencies {
    implementation("com.agui:kotlin-client:0.2.1")
}
```

```kotlin
import com.agui.client.*

val agent = AgUiAgent("https://your-agent-api.com/agent") {
    bearerToken = "your-api-token"
}

agent.sendMessage("Hello!").collect { event ->
    // Handle streaming responses
}
```

## 💻 Development Setup

```bash
git clone https://github.com/ag-ui-protocol/ag-ui.git
cd ag-ui/sdks/community/kotlin/library
./gradlew build
./gradlew test
```

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
