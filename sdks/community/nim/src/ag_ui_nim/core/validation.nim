## Errors and policy for decoding AG-UI JSON.
##
## A rejected document raises `ValidationError`, which names the JSON Schema
## keyword of the rule that rejected it and the JSON Pointer of the offending
## instance, in the vocabulary `spec/1.0/schema.json` uses.
##
## The 1.0 schema closes every object. A receiver is asked to be more forgiving
## than the schema (spec/README.md, DEPRECATIONS.md): it strips fields it does
## not recognise and reads a listed set of pre-1.0 whole-field `null`s as
## absent, warning about both. `DecodePolicy` selects between the two.

import std/strutils

type
  SchemaKeyword* = enum
    ## The JSON Schema 2020-12 keyword of the rule a document broke.
    skType = "type"
    skRequired = "required"
    skConst = "const"
    skEnum = "enum"
    skUnevaluatedProperties = "unevaluatedProperties"
    skMinimum = "minimum"
    skMaximum = "maximum"
    skPattern = "pattern"
    skMinItems = "minItems"
    skNot = "not"
    skOneOf = "oneOf"

  ValidationError* = object of CatchableError
    keyword*: SchemaKeyword
    instanceLocation*: string ## JSON Pointer into the decoded document

  DecodePolicy* = enum
    dpStrict   ## exactly the 1.0 schema: unknown fields and whole-field nulls fail
    dpReceiver ## receiver boundary: strip unknown fields and read the
               ## deprecated whole-field nulls as absent, with a warning each

  DecodeContext* = object
    policy*: DecodePolicy
    warnings*: seq[string] ## what a `dpReceiver` decode stripped or converted

const
  MaxSafeInteger* = 9007199254740991'i64 ## 2^53 - 1, the schema's integer bound
  MinSafeInteger* = -9007199254740991'i64

proc strictContext*(): DecodeContext {.raises: [].} =
  DecodeContext(policy: dpStrict)

proc receiverContext*(): DecodeContext {.raises: [].} =
  DecodeContext(policy: dpReceiver)

proc newValidationError*(keyword: SchemaKeyword, instanceLocation,
                         message: string): ref ValidationError {.raises: [].} =
  result = newException(ValidationError,
    (if instanceLocation.len == 0: "/" else: instanceLocation) & ": " & message)
  result.keyword = keyword
  result.instanceLocation = instanceLocation

proc escapePointerToken*(token: string): string {.raises: [].} =
  ## RFC 6901 escaping of one reference token.
  token.replace("~", "~0").replace("/", "~1")

proc childPointer*(parent, token: string): string {.raises: [].} =
  parent & "/" & escapePointerToken(token)

proc childPointer*(parent: string, index: int): string {.raises: [].} =
  parent & "/" & $index

proc isJsonPointer*(s: string): bool {.raises: [].} =
  ## `^(/([^/~]|~[01])*)*$` — the schema's `JsonPointer` pattern.
  if s.len == 0:
    return true
  if s[0] != '/':
    return false
  var i = 0
  while i < s.len:
    if s[i] == '~':
      if i + 1 >= s.len or s[i + 1] notin {'0', '1'}:
        return false
      inc i
    inc i
  true

# Field annotations read by the codec (see codec.nim).
template jsonObject*() {.pragma.}
  ## The JSON value must be an object (`Metadata`, activity `content`,
  ## `responseSchema`, `custom`).
template nonNegative*() {.pragma.}
  ## The integer has `minimum: 0`.
template nullAsAbsent*() {.pragma.}
  ## A whole `null` in place of this optional field is a deprecated pre-1.0
  ## shape (DEPRECATIONS.md) that a `dpReceiver` decode reads as absent.
