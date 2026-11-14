## Field-by-field JSON codec for the AG-UI object types.
##
## Every object definition in `spec/1.0/schema.json` maps to a Nim object whose
## field names are the wire names. A required property is a plain field, an
## optional one is an `Option`; the annotations in validation.nim carry the
## constraints a Nim type cannot (object-only JSON, `minimum: 0`, deprecated
## nulls). Unions (`oneOf`) are object variants with hand-written codecs.
##
## Encoding omits an absent optional field instead of writing `null`
## (sdks/fixtures/README.md, "null-omission").

import std/[json, macros, options]
import ./validation

export validation

proc typeError(path, expected: string): ref ValidationError {.raises: [].} =
  newValidationError(skType, path, "expected " & expected)

proc decodeInteger(n: JsonNode, path: string, nonNeg: bool): int64 {.
    raises: [ValidationError].} =
  case n.kind
  of JInt:
    result = n.getBiggestInt
  of JFloat:
    # JSON Schema counts 2.0 as an integer; 2.5 is not one.
    let f = n.getFloat
    if f > float(MaxSafeInteger):
      raise newValidationError(skMaximum, path, "integer above 2^53-1")
    if f < float(MinSafeInteger):
      raise newValidationError(skMinimum, path, "integer below -(2^53-1)")
    if f != float(int64(f)):
      raise typeError(path, "an integer")
    result = int64(f)
  of JString:
    # std/json keeps an integer literal too large for int64 as an unquoted
    # string; it is a number, out of range, not a string.
    let text = $n
    if text.len > 0 and text[0] != '"':
      if text[0] == '-':
        raise newValidationError(skMinimum, path, "integer below -(2^53-1)")
      raise newValidationError(skMaximum, path, "integer above 2^53-1")
    raise typeError(path, "an integer")
  else:
    raise typeError(path, "an integer")
  if result > MaxSafeInteger:
    raise newValidationError(skMaximum, path, "integer above 2^53-1")
  if result < (if nonNeg: 0'i64 else: MinSafeInteger):
    raise newValidationError(skMinimum, path,
      if nonNeg: "integer below 0" else: "integer below -(2^53-1)")

proc decodeEnum[T: enum](n: JsonNode, path: string): T {.
    raises: [ValidationError].} =
  if n.kind != JString:
    raise typeError(path, "a string")
  let s = n.getStr
  for e in low(T) .. high(T):
    if $e == s:
      return e
  let keyword = if ord(high(T)) == ord(low(T)): skConst else: skEnum
  raise newValidationError(keyword, path, "unexpected value '" & s & "'")

proc decodeAny*[T](n: JsonNode, path: string, ctx: var DecodeContext,
                   v: var T, objectOnly = false, nonNeg = false) {.
    raises: [ValidationError].} =
  ## Decodes one JSON value into `v`, dispatching on the Nim type.
  mixin decodeValue
  when T is string:
    if n.kind != JString:
      raise typeError(path, "a string")
    v = n.getStr
  elif T is bool:
    if n.kind != JBool:
      raise typeError(path, "a boolean")
    v = n.getBool
  elif T is int64:
    v = decodeInteger(n, path, nonNeg)
  elif T is enum:
    v = decodeEnum[T](n, path)
  elif T is JsonNode:
    if objectOnly and n.kind != JObject:
      raise typeError(path, "an object")
    v = n.copy
  elif T is seq:
    if n.kind != JArray:
      raise typeError(path, "an array")
    v.setLen(n.len)
    for i in 0 ..< n.len:
      decodeAny(n.elems[i], childPointer(path, i), ctx, v[i])
  else:
    decodeValue(n, path, ctx, v)

proc rejectOrStripUnknown*(n: JsonNode, path: string, ctx: var DecodeContext,
                           known: openArray[string]) {.
    raises: [ValidationError].} =
  ## Applies the policy to every member of `n` not named in `known`.
  for key in n.keys:
    if key notin known:
      case ctx.policy
      of dpStrict:
        raise newValidationError(skUnevaluatedProperties, path,
          "unknown property '" & key & "'")
      of dpReceiver:
        ctx.warnings.add(childPointer(path, key) & ": unknown property stripped")

proc decodeFields*[T: object](n: JsonNode, path: string,
                              ctx: var DecodeContext, v: var T,
                              handledElsewhere: openArray[string] = [],
                              checkUnknown = true) {.
    raises: [ValidationError].} =
  ## Decodes the members of the JSON object `n` into the fields of `v`.
  ## `handledElsewhere` names members a caller decodes itself (a union's
  ## discriminator, the event envelope), so they are not reported as unknown;
  ## `checkUnknown = false` leaves unknown members to the caller entirely.
  if n.kind != JObject:
    raise typeError(path, "an object")
  var known = @handledElsewhere
  for name, f in v.fieldPairs:
    known.add name
    let child = childPointer(path, name)
    let present = n.hasKey(name)
    let c = if present: n.getOrDefault(name) else: nil
    when f is Option:
      if present:
        var tolerated = false
        when f.hasCustomPragma(nullAsAbsent):
          if c.kind == JNull and ctx.policy == dpReceiver:
            ctx.warnings.add(child & ": deprecated null read as absent")
            tolerated = true
        if not tolerated:
          when typeof(f.get) is JsonNode:
            if c.kind == JNull:
              when f.hasCustomPragma(jsonObject):
                raise typeError(child, "an object")
              else:
                raise newValidationError(skNot, child,
                  "null is not allowed; omit the field instead")
          var x: typeof(f.get)
          decodeAny(c, child, ctx, x, f.hasCustomPragma(jsonObject),
                    f.hasCustomPragma(nonNegative))
          f = some(x)
    else:
      if not present:
        raise newValidationError(skRequired, path,
          "missing required property '" & name & "'")
      decodeAny(c, child, ctx, f, f.hasCustomPragma(jsonObject),
                f.hasCustomPragma(nonNegative))
  if checkUnknown:
    rejectOrStripUnknown(n, path, ctx, known)

proc encodeAny*[T](v: T): JsonNode {.raises: [].} =
  ## Encodes one value; the inverse of `decodeAny`.
  mixin toJson
  when T is string:
    newJString(v)
  elif T is bool:
    newJBool(v)
  elif T is int64:
    newJInt(v)
  elif T is enum:
    newJString($v)
  elif T is JsonNode:
    if v.isNil: newJNull() else: v.copy
  elif T is seq:
    var arr = newJArray()
    for item in v:
      arr.add encodeAny(item)
    arr
  else:
    toJson(v)

proc encodeFields*[T: object](v: T, o: JsonNode) {.raises: [].} =
  ## Writes the fields of `v` into the JSON object `o`, leaving absent
  ## optional fields out.
  for name, f in v.fieldPairs:
    when f is Option:
      if f.isSome:
        when typeof(f.get) is JsonNode:
          # A whole optional null means absence; it is never written.
          if not f.get.isNil and f.get.kind != JNull:
            o[name] = encodeAny(f.get)
        else:
          o[name] = encodeAny(f.get)
    else:
      o[name] = encodeAny(f)

template objectCodec*(T: typedesc) =
  ## Declares `decodeValue` and `toJson` for a plain object definition.
  proc decodeValue*(n: JsonNode, path: string, ctx: var DecodeContext,
                    v: var T) {.raises: [ValidationError].} =
    decodeFields(n, path, ctx, v)

  proc toJson*(v: T): JsonNode {.raises: [].} =
    result = newJObject()
    encodeFields(v, result)

proc fromJson*[T](n: JsonNode, _: typedesc[T], ctx: var DecodeContext): T {.
    raises: [ValidationError].} =
  ## Decodes `n` as a `T` under `ctx.policy`, collecting warnings in `ctx`.
  decodeAny(n, "", ctx, result)

proc fromJson*[T](n: JsonNode, _: typedesc[T]): T {.raises: [ValidationError].} =
  ## Decodes `n` as a `T` against the 1.0 schema exactly.
  var ctx = strictContext()
  decodeAny(n, "", ctx, result)
