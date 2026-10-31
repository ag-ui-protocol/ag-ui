# AG-UI Kotlin SDK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Kotlin](https://img.shields.io/badge/kotlin-2.1.21-blue.svg?logo=kotlin)](http://kotlinlang.org)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20iOS%20%7C%20macOS%20%7C%20JVM%20%7C%20Wasm-lightgrey)](https://kotlinlang.org/docs/multiplatform.html)
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
    implementation("com.agui:kotlin-client:0.2.3")
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

## Releases

Kotlin uses the shared [prepare-release](../../../.github/workflows/prepare-release.yml) and
[publish-release](../../../.github/workflows/publish-release.yml) workflows. Select
`sdk-kotlin` with the `create-pr` action and a stable patch, minor, or major bump.
Review the three generated module changelog entries before merging `release/next`.
The first automated release has approximate history when no prior package tag
exists; review those notes carefully. Maven Central releases are stable only.

After merge, shared CI compares the three module versions with Maven Central and
runs Gradle tests and unsigned staging for new versions. The staged repository
passes between jobs in the same workflow run at the selected source commit.
Kotlin publishes last, waits for the generated POMs to become visible, then records
package tags and the reviewed notes. All 24 Gradle publications are staged,
including iosX64 for Intel Mac consumers.

A workflow dry run builds pending packages without deployment, release records,
branch cleanup or notifications. Already published versions require no staging.

Local commands (run from this directory) require JDK21, Python3.12, jq, Android SDK36
and build-tools36.0.0, plus Xcode on macOS for multiplatform staging:

```bash
./publish.sh --dry-run       # Real clean/tests/staging; no credentials
./publish.sh --stage-only    # Same staging path; retain unsigned repository
./publish.sh                 # Stage and upload the full repository
./publish.sh --deploy-only --repository /path/to/staged/repository
```

Deploy-only consumes the staged repository;
it does not rebuild or test. Deployment requires environment variables
`JRELEASER_MAVENCENTRAL_SONATYPE_USERNAME`,
`JRELEASER_MAVENCENTRAL_SONATYPE_PASSWORD`, `JRELEASER_GPG_PASSPHRASE`,
`JRELEASER_GPG_PUBLIC_KEY`, and `JRELEASER_GPG_SECRET_KEY`. Keep credentials in
your secret manager. Local commands do not create the shared workflow's release
records.

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
