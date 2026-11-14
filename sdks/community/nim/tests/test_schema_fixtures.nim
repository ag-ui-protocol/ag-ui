## The spec's own fixtures, spec/1.0/fixtures/<Definition>/{valid,invalid}.
##
## Every valid document decodes against its definition under the strict
## (schema) policy and re-encodes to the same JSON value. Every invalid
## document is rejected, for the rule its `.expect.json` names: the error is
## either at the expected instance location with the expected keyword, or —
## where the schema reports a union (`oneOf`) failure — inside that location.

import std/[json, os, sequtils, strutils, tables, unittest, enumutils]
import ag_ui_nim/core

const fixtureRoot = currentSourcePath().parentDir / ".." / ".." / ".." / ".." /
  "spec" / "1.0" / "fixtures"

type Decoder = proc (n: JsonNode, ctx: var DecodeContext): JsonNode

proc roundTrip[T](n: JsonNode, ctx: var DecodeContext): JsonNode =
  fromJson(n, T, ctx).toJson

proc eventDecoder(kind: EventType): Decoder =
  result = proc (n: JsonNode, ctx: var DecodeContext): JsonNode =
    let e = fromJson(n, Event, ctx)
    check e.kind == kind
    e.toJson

proc messageDecoder(role: Role): Decoder =
  result = proc (n: JsonNode, ctx: var DecodeContext): JsonNode =
    let m = fromJson(n, Message, ctx)
    check m.role == role
    m.toJson

proc partSourceDecoder(kind: PartSourceType): Decoder =
  result = proc (n: JsonNode, ctx: var DecodeContext): JsonNode =
    let s = fromJson(n, PartSource, ctx)
    check s.kind == kind
    s.toJson

proc decoders(): Table[string, Decoder] =
  for kind in EventType:
    # etTextMessageStart -> TextMessageStartEvent
    result[symbolName(kind)[2 .. ^1] & "Event"] = eventDecoder(kind)
  for role in Role:
    result[symbolName(role)[4 .. ^1] & "Message"] = messageDecoder(role)
  for kind in PartSourceType:
    result[symbolName(kind)[3 .. ^1] & "Source"] = partSourceDecoder(kind)
  result["AgentCapabilities"] = roundTrip[AgentCapabilities]
  result["ExecutionCapabilities"] = roundTrip[ExecutionCapabilities]
  result["MultiAgentCapabilities"] = roundTrip[MultiAgentCapabilities]
  result["SubagentInfo"] = roundTrip[SubagentInfo]
  result["Interrupt"] = roundTrip[Interrupt]
  result["ResumeEntry"] = roundTrip[ResumeEntry]
  result["RunAgentInput"] = roundTrip[RunAgentInput]
  result["Tool"] = roundTrip[Tool]

const definedPatchMembers = {
  "add": @["op", "path", "value"], "replace": @["op", "path", "value"],
  "test": @["op", "path", "value"], "remove": @["op", "path"],
  "move": @["op", "from", "path"], "copy": @["op", "from", "path"]}.toTable

proc withoutIgnoredPatchMembers(event: JsonNode): JsonNode =
  ## RFC 6902 §4: members an operation does not define are ignored. The Nim
  ## operation type does not carry them, so they are not re-encoded.
  result = event.copy
  for key in ["delta", "patch"]:
    if result.hasKey(key) and result[key].kind == JArray:
      for op in result[key].elems:
        for member in toSeq(op.keys):
          if member notin definedPatchMembers[op["op"].getStr]:
            op.delete(member)

proc isUnder(location, ancestor: string): bool =
  location.startsWith(ancestor & "/")

let table = decoders()

suite "spec/1.0 fixtures":
  test "the fixture directory is present":
    check dirExists(fixtureRoot)

  for defDir in walkDirs(fixtureRoot / "*"):
    let def = defDir.lastPathPart

    test "a decoder exists for " & def:
      check table.hasKey(def)
    if not table.hasKey(def):
      continue
    let decode = table[def]

    for file in walkFiles(defDir / "valid" / "*.json"):
      test "valid " & def & "/" & file.extractFilename & " round-trips":
        let doc = parseFile(file)
        var ctx = strictContext()
        let encoded = decode(doc, ctx)
        check encoded == withoutIgnoredPatchMembers(doc)
        check ctx.warnings.len == 0

    for file in walkFiles(defDir / "invalid" / "*.json"):
      if file.endsWith(".expect.json"):
        continue
      test "invalid " & def & "/" & file.extractFilename & " is rejected":
        let doc = parseFile(file)
        let expect = parseFile(file.changeFileExt("").changeFileExt("") &
          ".expect.json")
        let keyword = expect["keyword"].getStr
        let location = expect["instanceLocation"].getStr
        var ctx = strictContext()
        try:
          discard decode(doc, ctx)
          checkpoint "accepted a document the schema rejects"
          fail()
        except ValidationError as e:
          checkpoint "got " & $e.keyword & " at '" & e.instanceLocation &
            "': " & e.msg
          if e.instanceLocation == location:
            check $e.keyword == keyword
          else:
            check keyword == "oneOf"
            check e.instanceLocation.isUnder(location)
