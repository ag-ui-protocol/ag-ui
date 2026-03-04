#!/bin/bash

# AG-UI Kotlin SDK Publishing Script
# Publishes kotlin-core, kotlin-client, and kotlin-tools to Maven Central via Sonatype Portal

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse command line arguments
DRY_RUN=false
for arg in "$@"; do
    case $arg in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --dry-run    Test the publishing process without uploading to Maven Central"
            echo "  -h, --help   Show this help message"
            echo ""
            echo "Required Environment Variables:"
            echo "  JRELEASER_MAVENCENTRAL_SONATYPE_USERNAME - Sonatype Portal username (user token)"
            echo "  JRELEASER_MAVENCENTRAL_SONATYPE_PASSWORD - Sonatype Portal password (user token)"
            echo "  JRELEASER_GPG_PASSPHRASE                 - GPG key passphrase"
            echo "  JRELEASER_GPG_PUBLIC_KEY                 - Base64-encoded GPG public key"
            echo "  JRELEASER_GPG_SECRET_KEY                 - Base64-encoded GPG private key"
            echo ""
            echo "Generate user tokens at: https://central.sonatype.com/account"
            exit 0
            ;;
    esac
done

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}AG-UI Kotlin SDK Publishing Script${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if running in dry-run mode
if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}⚠️  DRY RUN MODE - No artifacts will be uploaded${NC}"
    echo ""
fi

# Verify required environment variables (unless dry-run)
if [ "$DRY_RUN" = false ]; then
    echo -e "${BLUE}🔍 Checking required environment variables...${NC}"

    MISSING_VARS=()

    if [ -z "$JRELEASER_MAVENCENTRAL_SONATYPE_USERNAME" ]; then
        MISSING_VARS+=("JRELEASER_MAVENCENTRAL_SONATYPE_USERNAME")
    fi

    if [ -z "$JRELEASER_MAVENCENTRAL_SONATYPE_PASSWORD" ]; then
        MISSING_VARS+=("JRELEASER_MAVENCENTRAL_SONATYPE_PASSWORD")
    fi

    if [ -z "$JRELEASER_GPG_PASSPHRASE" ]; then
        MISSING_VARS+=("JRELEASER_GPG_PASSPHRASE")
    fi

    if [ -z "$JRELEASER_GPG_PUBLIC_KEY" ]; then
        MISSING_VARS+=("JRELEASER_GPG_PUBLIC_KEY")
    fi

    if [ -z "$JRELEASER_GPG_SECRET_KEY" ]; then
        MISSING_VARS+=("JRELEASER_GPG_SECRET_KEY")
    fi

    if [ ${#MISSING_VARS[@]} -ne 0 ]; then
        echo -e "${RED}❌ Error: Missing required environment variables:${NC}"
        for var in "${MISSING_VARS[@]}"; do
            echo -e "${RED}   - $var${NC}"
        done
        echo ""
        echo "Generate credentials at: https://central.sonatype.com/account"
        echo "Run with --help for more information"
        exit 1
    fi

    echo -e "${GREEN}✅ All required environment variables are set${NC}"
    echo ""
fi

# Navigate to library directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/library" || exit 1

echo -e "${BLUE}📂 Working directory: $(pwd)${NC}"

# Extract version from build.gradle.kts
VERSION=$(grep "^version = " build.gradle.kts | sed 's/version = "\(.*\)"/\1/')
echo -e "${BLUE}📦 Version: ${VERSION}${NC}"
echo ""

# Step 1: Clean previous builds and staging directory
echo -e "${BLUE}🧹 Cleaning previous builds...${NC}"
./gradlew clean --no-daemon

# Also clean the staging directory to remove any leftover artifacts
if [ -d "build/staging-deploy" ]; then
    echo -e "${BLUE}🧹 Cleaning staging directory...${NC}"
    rm -rf build/staging-deploy
fi

echo -e "${GREEN}✅ Clean complete${NC}"
echo ""

# Step 2: Run tests
echo -e "${BLUE}🧪 Running tests...${NC}"
./gradlew allTests --no-daemon
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Tests failed! Publishing aborted.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ All tests passed${NC}"
echo ""

# Step 3: Build and publish to staging
echo -e "${BLUE}📦 Building and staging artifacts...${NC}"
./gradlew publish --no-daemon
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Build failed! Publishing aborted.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Artifacts built and staged${NC}"
echo ""

# Step 4: Deploy to Maven Central (or dry-run)
if [ "$DRY_RUN" = true ]; then
    echo -e "${BLUE}🔍 Running JReleaser in dry-run mode...${NC}"
    ./gradlew jreleaserDeploy --dry-run --no-daemon
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        echo ""
        echo -e "${GREEN}✅ Dry-run completed successfully!${NC}"
        echo -e "${YELLOW}⚠️  No artifacts were uploaded (dry-run mode)${NC}"
    else
        echo ""
        echo -e "${RED}❌ Dry-run failed!${NC}"
        exit $EXIT_CODE
    fi
else
    echo -e "${BLUE}🚀 Deploying to Maven Central...${NC}"
    ./gradlew jreleaserDeploy --no-daemon
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        echo ""
        echo -e "${GREEN}========================================${NC}"
        echo -e "${GREEN}✅ Publishing completed successfully!${NC}"
        echo -e "${GREEN}========================================${NC}"
        echo ""
        echo -e "${BLUE}📋 Next steps:${NC}"
        echo "   1. Check deployment status at: https://central.sonatype.com/publishing"
        echo "   2. Artifacts will be validated automatically"
        echo "   3. Publishing to Maven Central will complete in ~10-30 minutes"
        echo ""
        echo -e "${BLUE}📦 Published artifacts:${NC}"
        echo "   - com.ag-ui.community:kotlin-core:${VERSION} (JVM, Android, iOS)"
        echo "   - com.ag-ui.community:kotlin-client:${VERSION} (JVM, Android, iOS)"
        echo "   - com.ag-ui.community:kotlin-tools:${VERSION} (JVM, Android, iOS)"
        echo ""
        echo -e "${BLUE}ℹ️  All platforms published including iOS (.klib format)${NC}"
    else
        echo ""
        echo -e "${RED}❌ Publishing failed!${NC}"
        echo "Check the output above for error details."
        exit $EXIT_CODE
    fi
fi

echo ""
