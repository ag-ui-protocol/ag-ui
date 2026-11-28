## The cross-language fixtures in sdks/fixtures (see its README.md).
##
## Every case is walked, whatever its `producedBy` list says: that list names
## the first-party SDKs, and this SDK implements every event type the cases
## use.

import std/[json, os, strutils, unittest]
import ag_ui_nim/core
import ag_ui_nim/encoder

const sharedFixtures = currentSourcePath().parentDir / ".." / ".." / ".." /
  "fixtures"

proc producedJson(event: Event): JsonNode =
  ## The JSON the official producer path (the SSE encoder) emits.
  let frame = encodeSse(event)
  check frame.startsWith("data: ")
  check frame.endsWith("\n\n")
  parseJson(frame["data: ".len ..< frame.len - 2])

suite "sdks/fixtures/null-omission.json":
  let doc = parseFile(sharedFixtures / "null-omission.json")
  for fixtureCase in doc["stream"].elems:
    let name = fixtureCase["name"].getStr
    test name & ": a receiver decodes the input and the encoder emits exactly the expected JSON":
      var ctx = receiverContext()
      let event = fromJson(fixtureCase["input"], Event, ctx)
      check producedJson(event) == fixtureCase["expected"]
      # A deprecated whole-field null is the only thing the input may carry
      # that the expected output does not, and reading it warns.
      check (ctx.warnings.len > 0) == (fixtureCase["input"] != fixtureCase["expected"])

suite "sdks/fixtures/agent-capabilities.json":
  let doc = parseFile(sharedFixtures / "agent-capabilities.json")
  for fixtureCase in doc["cases"].elems:
    let name = fixtureCase["name"].getStr
    test name & ": parsing and serializing yields exactly the expected JSON":
      let caps = fromJson(fixtureCase["input"], AgentCapabilities)
      check caps.toJson == fixtureCase["expected"]
