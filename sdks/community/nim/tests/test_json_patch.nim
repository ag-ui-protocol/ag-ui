## Applying JSON Patch (RFC 6902), used by STATE_DELTA and ACTIVITY_DELTA.
## The cases named A.n are the examples of RFC 6902 Appendix A.

import std/[json, unittest]
import ag_ui_nim/core

proc patched(doc, patch: string): JsonNode =
  applyPatch(parseJson(doc), fromJson(parseJson(patch), JsonPatch))

proc rejects(doc, patch: string): bool =
  try:
    discard patched(doc, patch)
    false
  except JsonPatchError:
    true

suite "JSON Patch: RFC 6902 Appendix A":
  test "A.1 adding an object member":
    check patched("""{"foo":"bar"}""",
      """[{"op":"add","path":"/baz","value":"qux"}]""") ==
      parseJson("""{"baz":"qux","foo":"bar"}""")

  test "A.2 adding an array element":
    check patched("""{"foo":["bar","baz"]}""",
      """[{"op":"add","path":"/foo/1","value":"qux"}]""") ==
      parseJson("""{"foo":["bar","qux","baz"]}""")

  test "A.3 removing an object member":
    check patched("""{"baz":"qux","foo":"bar"}""",
      """[{"op":"remove","path":"/baz"}]""") == parseJson("""{"foo":"bar"}""")

  test "A.4 removing an array element":
    check patched("""{"foo":["bar","qux","baz"]}""",
      """[{"op":"remove","path":"/foo/1"}]""") ==
      parseJson("""{"foo":["bar","baz"]}""")

  test "A.5 replacing a value":
    check patched("""{"baz":"qux","foo":"bar"}""",
      """[{"op":"replace","path":"/baz","value":"boo"}]""") ==
      parseJson("""{"baz":"boo","foo":"bar"}""")

  test "A.6 moving a value":
    check patched(
      """{"foo":{"bar":"baz","waldo":"fred"},"qux":{"corge":"grault"}}""",
      """[{"op":"move","from":"/foo/waldo","path":"/qux/thud"}]""") ==
      parseJson("""{"foo":{"bar":"baz"},"qux":{"corge":"grault","thud":"fred"}}""")

  test "A.7 moving an array element":
    check patched("""{"foo":["all","grass","cows","eat"]}""",
      """[{"op":"move","from":"/foo/1","path":"/foo/3"}]""") ==
      parseJson("""{"foo":["all","cows","eat","grass"]}""")

  test "A.8 a successful test leaves the document unchanged":
    check patched("""{"baz":"qux","foo":["a",2,"c"]}""",
      """[{"op":"test","path":"/baz","value":"qux"},
          {"op":"test","path":"/foo/1","value":2}]""") ==
      parseJson("""{"baz":"qux","foo":["a",2,"c"]}""")

  test "A.9 a failed test is an error":
    check rejects("""{"baz":"qux"}""",
      """[{"op":"test","path":"/baz","value":"bar"}]""")

  test "A.10 adding a nested member object":
    check patched("""{"foo":"bar"}""",
      """[{"op":"add","path":"/child","value":{"grandchild":{}}}]""") ==
      parseJson("""{"foo":"bar","child":{"grandchild":{}}}""")

  test "A.11 members an operation does not define are ignored":
    check patched("""{"foo":"bar"}""",
      """[{"op":"add","path":"/baz","value":"qux","xyz":123}]""") ==
      parseJson("""{"foo":"bar","baz":"qux"}""")

  test "A.12 adding to a nonexistent target is an error":
    check rejects("""{"foo":"bar"}""",
      """[{"op":"add","path":"/baz/bat","value":"qux"}]""")

  test "A.14 '~01' unescapes to '~1', not '/'":
    check patched("""{"/":9,"~1":10}""",
      """[{"op":"test","path":"/~01","value":10}]""") ==
      parseJson("""{"/":9,"~1":10}""")

  test "A.15 a string never equals a number":
    check rejects("""{"/":9,"~1":10}""",
      """[{"op":"test","path":"/~01","value":"10"}]""")

  test "A.16 adding an array value with '-' appends it as one element":
    check patched("""{"foo":["bar"]}""",
      """[{"op":"add","path":"/foo/-","value":["abc","def"]}]""") ==
      parseJson("""{"foo":["bar",["abc","def"]]}""")

suite "JSON Patch: the rules around the examples":
  test "a patch is atomic: when an operation fails the input is unchanged":
    let doc = parseJson("""{"a":1}""")
    let patch = fromJson(parseJson("""[{"op":"add","path":"/b","value":2},
      {"op":"remove","path":"/missing"}]"""), JsonPatch)
    expect JsonPatchError:
      discard applyPatch(doc, patch)
    check doc == parseJson("""{"a":1}""")

  test "the error names the index of the failing operation":
    try:
      discard patched("""{"a":1}""", """[{"op":"remove","path":"/a"},
        {"op":"remove","path":"/a"}]""")
      fail()
    except JsonPatchError as e:
      check e.operationIndex == 1

  test "the empty path addresses the whole document":
    check patched("""{"a":1}""",
      """[{"op":"replace","path":"","value":[1,2]}]""") == parseJson("[1,2]")

  test "test compares numbers by value":
    check patched("""{"n":1}""",
      """[{"op":"test","path":"/n","value":1.0}]""") == parseJson("""{"n":1}""")

  test "test compares objects regardless of member order":
    check patched("""{"o":{"a":1,"b":[true,null]}}""",
      """[{"op":"test","path":"/o","value":{"b":[true,null],"a":1}}]""") ==
      parseJson("""{"o":{"a":1,"b":[true,null]}}""")

  test "an array index with a leading zero is an error":
    check rejects("""{"a":[1,2]}""", """[{"op":"remove","path":"/a/01"}]""")

  test "an array index past the end is an error":
    check rejects("""{"a":[1,2]}""", """[{"op":"add","path":"/a/3","value":0}]""")

  test "remove and replace need an existing target":
    check rejects("""{"a":[1]}""", """[{"op":"remove","path":"/a/1"}]""")
    check rejects("""{}""", """[{"op":"replace","path":"/x","value":0}]""")

  test "a value cannot be moved into one of its own children":
    check rejects("""{"a":{"b":{}}}""",
      """[{"op":"move","from":"/a","path":"/a/b/c"}]""")

  test "copy duplicates the value without aliasing it":
    let result = patched("""{"a":{"x":1}}""",
      """[{"op":"copy","from":"/a","path":"/b"},
          {"op":"replace","path":"/b/x","value":2}]""")
    check result == parseJson("""{"a":{"x":1},"b":{"x":2}}""")
