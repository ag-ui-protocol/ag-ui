function getTimestamp() {
  return (process.env.CI || process.env.VERBOSE)
    ? new Date().toLocaleTimeString('en-US', { hour12: false })
    : '';
}

function logStamp(...args) {
  console.log(getTimestamp(), ...args);
}

class CleanReporter {
  onBegin(config, suite) {
    console.log(`\n🎭 Running ${suite.allTests().length} tests...\n`);
  }

  onTestEnd(test, result) {
    const suiteName = test.parent?.title || "Unknown";
    const testName = test.title;

    // Clean up suite name
    const cleanSuite = suiteName
      .replace(/Tests?$/i, "")
      .replace(/Page$/i, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim();

    if (result.status === "passed") {
      logStamp(`✅ ${cleanSuite}: ${testName}`);
    } else if (result.status === "failed") {
      logStamp(`❌ ${cleanSuite}: ${testName}`);

      // Extract the most relevant error info
      const error = result.error || result.errors?.[0];
      if (error) {
        let errorMsg = error.message || "Unknown error";

        // Clean up common error patterns to make them more readable
        if (errorMsg.includes("None of the expected patterns matched")) {
          const patterns = errorMsg.match(/patterns matched[^:]*: ([^`]+)/);
          errorMsg = `AI response timeout - Expected: ${
            patterns?.[1] || "AI response"
          }`;
        } else if (
          errorMsg.includes("Timed out") &&
          errorMsg.includes("toBeVisible")
        ) {
          const element = errorMsg.match(/locator\('([^']+)'\)/);
          errorMsg = `Element not found: ${element?.[1] || "UI element"}`;
        } else if (errorMsg.includes("toBeGreaterThan")) {
          errorMsg = "Expected content not generated (count was 0)";
        }

        // Show just the key error info
        console.log(`   💥 ${errorMsg.split("\n")[0]}`);

        // If it's an AI/API issue, make it clear
        if (
          errorMsg.includes("AI") ||
          errorMsg.includes("patterns") ||
          errorMsg.includes("timeout")
        ) {
          console.log(`   🔑 Likely cause: AI service down or API key issue`);
        }
      }
      console.log(""); // Extra spacing after failures
    } else if (result.status === "skipped") {
      console.log(`⏭ ${cleanSuite}: ${testName} (skipped)`);
    }
  }

  onEnd(result) {
    console.log("\n" + "=".repeat(60));
    logStamp(`📊 TEST SUMMARY`);
    console.log("=".repeat(60));

    if (!process.env.CI) {
      console.log(
        `• Run 'pnpm exec playwright show-report' for detailed HTML report`
      );
    }

    console.log("=".repeat(60) + "\n");
  }
}

module.exports = CleanReporter;
