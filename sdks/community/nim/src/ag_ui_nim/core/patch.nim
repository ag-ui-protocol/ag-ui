## Applying a JSON Patch (RFC 6902) to a JSON document, as STATE_DELTA and
## ACTIVITY_DELTA require. The patch is atomic: the input is never modified,
## and an operation that cannot be applied fails the whole patch.

import std/[json, strutils, tables]
import ./types

type
  JsonPatchError* = object of CatchableError
    operationIndex*: int ## the position of the failing operation in the patch

proc patchError(index: int, message: string): ref JsonPatchError {.
    raises: [].} =
  result = newException(JsonPatchError,
    "JSON Patch operation " & $index & ": " & message)
  result.operationIndex = index

proc referenceTokens(pointer: string): seq[string] {.raises: [].} =
  ## RFC 6901: the tokens of a pointer, unescaping `~1` before `~0`.
  if pointer.len == 0:
    return @[]
  for raw in pointer[1 .. ^1].split('/'):
    result.add raw.replace("~1", "/").replace("~0", "~")

proc arrayIndex(token: string, length: int, allowEnd: bool,
                index: int): int {.raises: [JsonPatchError].} =
  ## An array index token: `-` (past the end, where allowed) or a decimal
  ## without leading zeros.
  if token == "-" and allowEnd:
    return length
  if token.len == 0 or (token.len > 1 and token[0] == '0'):
    raise patchError(index, "invalid array index '" & token & "'")
  for c in token:
    if c notin Digits:
      raise patchError(index, "invalid array index '" & token & "'")
  if token.len > 9:
    raise patchError(index, "array index '" & token & "' out of range")
  result = 0
  for c in token:
    result = result * 10 + (ord(c) - ord('0'))
  let limit = if allowEnd: length else: length - 1
  if result > limit:
    raise patchError(index, "array index " & token & " out of range")

proc resolve(doc: JsonNode, tokens: openArray[string],
             index: int): JsonNode {.raises: [JsonPatchError].} =
  result = doc
  for token in tokens:
    case result.kind
    of JObject:
      if not result.hasKey(token):
        raise patchError(index, "no member '" & token & "'")
      result = result.getOrDefault(token)
    of JArray:
      result = result.elems[arrayIndex(token, result.len, false, index)]
    else:
      raise patchError(index, "cannot descend into a " & $result.kind)

proc jsonEqual(a, b: JsonNode): bool {.raises: [].} =
  ## RFC 6902 §4.6 equality: numbers by value, objects regardless of member
  ## order.
  if a.kind in {JInt, JFloat} and b.kind in {JInt, JFloat}:
    if a.kind == JInt and b.kind == JInt:
      return a.getBiggestInt == b.getBiggestInt
    return a.getFloat == b.getFloat
  if a.kind != b.kind:
    return false
  case a.kind
  of JObject:
    if a.len != b.len:
      return false
    for key, value in a.pairs:
      if not b.hasKey(key) or not jsonEqual(value, b.getOrDefault(key)):
        return false
    true
  of JArray:
    if a.len != b.len:
      return false
    for i in 0 ..< a.len:
      if not jsonEqual(a.elems[i], b.elems[i]):
        return false
    true
  else:
    a == b

proc addValue(doc: var JsonNode, tokens: seq[string], value: JsonNode,
              index: int) {.raises: [JsonPatchError].} =
  if tokens.len == 0:
    doc = value
    return
  let parent = resolve(doc, tokens[0 ..< ^1], index)
  case parent.kind
  of JObject:
    parent[tokens[^1]] = value
  of JArray:
    parent.elems.insert(value, arrayIndex(tokens[^1], parent.len, true, index))
  else:
    raise patchError(index, "cannot add to a " & $parent.kind)

proc removeValue(doc: JsonNode, tokens: seq[string], index: int): JsonNode {.
    raises: [JsonPatchError].} =
  ## Removes the target and returns it.
  if tokens.len == 0:
    raise patchError(index, "cannot remove the whole document")
  let parent = resolve(doc, tokens[0 ..< ^1], index)
  case parent.kind
  of JObject:
    if not parent.hasKey(tokens[^1]):
      raise patchError(index, "no member '" & tokens[^1] & "'")
    result = parent.getOrDefault(tokens[^1])
    parent.fields.del(tokens[^1])
  of JArray:
    let i = arrayIndex(tokens[^1], parent.len, false, index)
    result = parent.elems[i]
    parent.elems.delete(i)
  else:
    raise patchError(index, "cannot remove from a " & $parent.kind)

proc isProperPrefix(prefix, tokens: seq[string]): bool {.raises: [].} =
  prefix.len < tokens.len and tokens[0 ..< prefix.len] == prefix

proc applyPatch*(document: JsonNode, patch: JsonPatch): JsonNode {.
    raises: [JsonPatchError].} =
  ## Returns `document` with every operation of `patch` applied in order.
  ## `document` itself is left unchanged.
  result = if document.isNil: newJNull() else: document.copy
  for index, operation in patch:
    let target = referenceTokens(operation.path)
    case operation.op
    of jpoAdd:
      addValue(result, target, operation.value.copy, index)
    of jpoRemove:
      discard removeValue(result, target, index)
    of jpoReplace:
      if target.len > 0:
        discard removeValue(result, target, index)
      addValue(result, target, operation.value.copy, index)
    of jpoMove:
      let source = referenceTokens(operation.`from`)
      if source.isProperPrefix(target):
        raise patchError(index, "cannot move a value into its own child")
      if source != target:
        let moved = removeValue(result, source, index)
        addValue(result, target, moved, index)
    of jpoCopy:
      let copied = resolve(result, referenceTokens(operation.`from`), index).copy
      addValue(result, target, copied, index)
    of jpoTest:
      if not jsonEqual(resolve(result, target, index), operation.value):
        raise patchError(index, "test failed at '" & operation.path & "'")
