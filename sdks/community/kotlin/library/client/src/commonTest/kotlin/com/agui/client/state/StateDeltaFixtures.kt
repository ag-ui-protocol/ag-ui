package com.agui.client.state

/**
 * Expected outcome of applying a state delta.
 */
internal sealed interface StateDeltaOutcome {
    /** The delta applies and produces [document]. */
    data class Applied(val document: String) : StateDeltaOutcome

    /** The delta is not a valid RFC 6902 patch document (unknown op, bad pointer, missing member). */
    data object Malformed : StateDeltaOutcome

    /** The delta is well formed but RFC 6902 says applying it is an error (missing target, failed test). */
    data object Unapplicable : StateDeltaOutcome

    /**
     * The delta would leave no state document. RFC 6902 allows this, but the application always keeps
     * a state document, so the delta is rejected.
     */
    data object AbsentDocument : StateDeltaOutcome
}

internal data class StateDeltaFixture(
    val name: String,
    val document: String,
    val delta: String,
    val outcome: StateDeltaOutcome,
)

private fun applied(name: String, document: String, delta: String, result: String) =
    StateDeltaFixture(name, document, delta, StateDeltaOutcome.Applied(result))

private fun malformed(name: String, document: String, delta: String) =
    StateDeltaFixture(name, document, delta, StateDeltaOutcome.Malformed)

private fun unapplicable(name: String, document: String, delta: String) =
    StateDeltaFixture(name, document, delta, StateDeltaOutcome.Unapplicable)

private fun absent(name: String, document: String, delta: String) =
    StateDeltaFixture(name, document, delta, StateDeltaOutcome.AbsentDocument)

/**
 * The behaviour adopted for state deltas, shared by [StateManager] and the event pipeline.
 *
 * RFC 6902 Appendix A (except A.13, which needs duplicate JSON keys) followed by edge cases for root
 * documents, array indices, pointers, copy/move, `test` and malformed operations.
 */
internal val stateDeltaFixtures: List<StateDeltaFixture> = listOf(
    // RFC 6902 Appendix A
    applied("A.1 add an object member", """{"foo":"bar"}""",
        """[{"op":"add","path":"/baz","value":"qux"}]""", """{"baz":"qux","foo":"bar"}"""),
    applied("A.2 add an array element", """{"foo":["bar","baz"]}""",
        """[{"op":"add","path":"/foo/1","value":"qux"}]""", """{"foo":["bar","qux","baz"]}"""),
    applied("A.3 remove an object member", """{"baz":"qux","foo":"bar"}""",
        """[{"op":"remove","path":"/baz"}]""", """{"foo":"bar"}"""),
    applied("A.4 remove an array element", """{"foo":["bar","qux","baz"]}""",
        """[{"op":"remove","path":"/foo/1"}]""", """{"foo":["bar","baz"]}"""),
    applied("A.5 replace a value", """{"baz":"qux","foo":"bar"}""",
        """[{"op":"replace","path":"/baz","value":"boo"}]""", """{"baz":"boo","foo":"bar"}"""),
    applied("A.6 move a value", """{"foo":{"bar":"baz","waldo":"fred"},"qux":{"corge":"grault"}}""",
        """[{"op":"move","from":"/foo/waldo","path":"/qux/thud"}]""",
        """{"foo":{"bar":"baz"},"qux":{"corge":"grault","thud":"fred"}}"""),
    applied("A.7 move an array element", """{"foo":["all","grass","cows","eat"]}""",
        """[{"op":"move","from":"/foo/1","path":"/foo/3"}]""", """{"foo":["all","cows","eat","grass"]}"""),
    applied("A.8 test a value: success", """{"baz":"qux","foo":["a",2,"c"]}""",
        """[{"op":"test","path":"/baz","value":"qux"},{"op":"test","path":"/foo/1","value":2}]""",
        """{"baz":"qux","foo":["a",2,"c"]}"""),
    unapplicable("A.9 test a value: error", """{"baz":"qux"}""",
        """[{"op":"test","path":"/baz","value":"bar"}]"""),
    applied("A.10 add a nested member object", """{"foo":"bar"}""",
        """[{"op":"add","path":"/child","value":{"grandchild":{}}}]""", """{"foo":"bar","child":{"grandchild":{}}}"""),
    applied("A.11 ignore unrecognized elements", """{"foo":"bar"}""",
        """[{"op":"add","path":"/baz","value":"qux","xyz":123}]""", """{"foo":"bar","baz":"qux"}"""),
    unapplicable("A.12 add to a nonexistent target", """{"foo":"bar"}""",
        """[{"op":"add","path":"/baz/bat","value":"qux"}]"""),
    applied("A.14 ~ escape ordering", """{"/":9,"~1":10}""",
        """[{"op":"test","path":"/~01","value":10}]""", """{"/":9,"~1":10}"""),
    unapplicable("A.15 comparing strings and numbers", """{"/":9,"~1":10}""",
        """[{"op":"test","path":"/~01","value":"10"}]"""),
    applied("A.16 add an array value", """{"foo":["bar"]}""",
        """[{"op":"add","path":"/foo/-","value":["abc","def"]}]""", """{"foo":["bar",["abc","def"]]}"""),

    // Root document
    applied("add at the root replaces the document", """{"a":1}""",
        """[{"op":"add","path":"","value":{"b":2}}]""", """{"b":2}"""),
    applied("replace at the root", """{"a":1}""",
        """[{"op":"replace","path":"","value":[1]}]""", """[1]"""),
    applied("test the whole document", """{"a":1}""",
        """[{"op":"test","path":"","value":{"a":1}}]""", """{"a":1}"""),
    unapplicable("test the whole document: mismatch", """{"a":1}""",
        """[{"op":"test","path":"","value":{"a":2}}]"""),
    applied("remove the root then add a new root", """{"a":1}""",
        """[{"op":"remove","path":""},{"op":"add","path":"","value":{"x":1}}]""", """{"x":1}"""),
    absent("remove the root", """{"a":1}""",
        """[{"op":"remove","path":""}]"""),
    unapplicable("operate on a removed root", """{"a":1}""",
        """[{"op":"remove","path":""},{"op":"add","path":"/a","value":2}]"""),
    unapplicable("add a member to a primitive document", "1",
        """[{"op":"add","path":"/a","value":2}]"""),

    // Arrays
    applied("add at array index 0", """{"foo":[1,2]}""",
        """[{"op":"add","path":"/foo/0","value":0}]""", """{"foo":[0,1,2]}"""),
    applied("add at array index equal to its size", """{"foo":[1,2]}""",
        """[{"op":"add","path":"/foo/2","value":3}]""", """{"foo":[1,2,3]}"""),
    unapplicable("add past the end of an array", """{"foo":[1,2]}""",
        """[{"op":"add","path":"/foo/3","value":3}]"""),
    applied("add with the - index appends", """{"foo":[1,2]}""",
        """[{"op":"add","path":"/foo/-","value":3}]""", """{"foo":[1,2,3]}"""),
    unapplicable("replace with the - index", """{"foo":[1,2]}""",
        """[{"op":"replace","path":"/foo/-","value":3}]"""),
    unapplicable("remove with the - index", """{"foo":[1,2]}""",
        """[{"op":"remove","path":"/foo/-"}]"""),
    unapplicable("add at array index with a leading zero", """{"foo":[1,2]}""",
        """[{"op":"add","path":"/foo/01","value":3}]"""),
    unapplicable("add at a negative array index", """{"foo":[1,2]}""",
        """[{"op":"add","path":"/foo/-1","value":3}]"""),
    unapplicable("add at a non-numeric array index", """{"foo":[1,2]}""",
        """[{"op":"add","path":"/foo/x","value":3}]"""),
    unapplicable("replace an array index out of range", """{"foo":[1,2]}""",
        """[{"op":"replace","path":"/foo/5","value":3}]"""),
    applied("replace an array element", """{"foo":[1,2]}""",
        """[{"op":"replace","path":"/foo/1","value":3}]""", """{"foo":[1,3]}"""),
    applied("remove the first array element", """{"foo":[1,2]}""",
        """[{"op":"remove","path":"/foo/0"}]""", """{"foo":[2]}"""),

    // Objects and pointers
    unapplicable("replace a missing member", """{"a":1}""",
        """[{"op":"replace","path":"/missing","value":2}]"""),
    unapplicable("remove a missing member", """{"a":1}""",
        """[{"op":"remove","path":"/missing"}]"""),
    applied("add an existing member replaces it", """{"a":1}""",
        """[{"op":"add","path":"/a","value":2}]""", """{"a":2}"""),
    applied("add a member with an empty name", """{"a":1}""",
        """[{"op":"add","path":"/","value":2}]""", """{"a":1,"":2}"""),
    applied("pointer escape ~1", """{}""",
        """[{"op":"add","path":"/a~1b","value":1}]""", """{"a/b":1}"""),
    applied("pointer escape ~0", """{}""",
        """[{"op":"add","path":"/m~0n","value":1}]""", """{"m~n":1}"""),
    applied("replace a nested member", """{"a":{"b":{"c":1}}}""",
        """[{"op":"replace","path":"/a/b/c","value":2}]""", """{"a":{"b":{"c":2}}}"""),
    applied("add a null value", """{}""",
        """[{"op":"add","path":"/a","value":null}]""", """{"a":null}"""),

    // copy and move
    applied("copy a member", """{"a":{"x":1}}""",
        """[{"op":"copy","from":"/a","path":"/b"}]""", """{"a":{"x":1},"b":{"x":1}}"""),
    applied("copy an array element to the end", """{"foo":[1,2]}""",
        """[{"op":"copy","from":"/foo/0","path":"/foo/-"}]""", """{"foo":[1,2,1]}"""),
    applied("copy the root into a member", """{"x":1}""",
        """[{"op":"copy","from":"","path":"/a"}]""", """{"x":1,"a":{"x":1}}"""),
    unapplicable("copy from a missing member", """{"a":1}""",
        """[{"op":"copy","from":"/missing","path":"/b"}]"""),
    applied("move a value onto itself", """{"a":1}""",
        """[{"op":"move","from":"/a","path":"/a"}]""", """{"a":1}"""),
    unapplicable("move a value into its own child", """{"nested":{"x":1}}""",
        """[{"op":"move","from":"/nested","path":"/nested/child"}]"""),
    unapplicable("move the root into a member", """{"x":1}""",
        """[{"op":"move","from":"","path":"/a"}]"""),
    unapplicable("move from a missing member", """{"a":1}""",
        """[{"op":"move","from":"/missing","path":"/b"}]"""),

    // Multiple operations
    applied("empty delta", """{"a":1}""", """[]""", """{"a":1}"""),
    applied("operations apply in order", """{"a":1}""",
        """[{"op":"add","path":"/b","value":2},{"op":"replace","path":"/b","value":3}]""", """{"a":1,"b":3}"""),
    unapplicable("a failing second operation rejects the whole delta", """{"a":1}""",
        """[{"op":"add","path":"/b","value":2},{"op":"remove","path":"/missing"}]"""),
    unapplicable("a failing test rejects earlier operations", """{"a":1}""",
        """[{"op":"add","path":"/b","value":2},{"op":"test","path":"/a","value":2}]"""),

    // test compares JSON values (RFC 6902 section 4.6)
    applied("test compares numbers by value", """{"a":1}""",
        """[{"op":"test","path":"/a","value":1.0}]""", """{"a":1}"""),
    unapplicable("test does not equate a number and a string", """{"a":1}""",
        """[{"op":"test","path":"/a","value":"1"}]"""),
    applied("test ignores object member order", """{"a":{"x":1,"y":2}}""",
        """[{"op":"test","path":"/a","value":{"y":2,"x":1}}]""", """{"a":{"x":1,"y":2}}"""),
    unapplicable("test compares array element order", """{"a":[1,2]}""",
        """[{"op":"test","path":"/a","value":[2,1]}]"""),
    unapplicable("test a missing member", """{"a":1}""",
        """[{"op":"test","path":"/missing","value":1}]"""),

    // Malformed patch documents
    malformed("unknown op", """{"a":1}""",
        """[{"op":"frobnicate","path":"/a","value":2}]"""),
    malformed("op is not a string", """{"a":1}""",
        """[{"op":5,"path":"/a","value":2}]"""),
    malformed("operation is not an object", """{"a":1}""",
        """[1]"""),
    malformed("path without a leading slash", """{"foo":1}""",
        """[{"op":"replace","path":"foo","value":2}]"""),
    malformed("from without a leading slash", """{"a":1}""",
        """[{"op":"copy","from":"a","path":"/b"}]"""),
    malformed("invalid pointer escape", """{"a":1}""",
        """[{"op":"add","path":"/a~2","value":2}]"""),
    malformed("missing path", """{"a":1}""",
        """[{"op":"remove"}]"""),
    malformed("null path", """{"a":1}""",
        """[{"op":"remove","path":null}]"""),
    malformed("add without a value", """{"a":1}""",
        """[{"op":"add","path":"/b"}]"""),
    malformed("replace without a value", """{"a":1}""",
        """[{"op":"replace","path":"/a"}]"""),
    malformed("test without a value", """{"a":1}""",
        """[{"op":"test","path":"/a"}]"""),
    malformed("copy without from", """{"a":1}""",
        """[{"op":"copy","path":"/b"}]"""),
    malformed("move without from", """{"a":1}""",
        """[{"op":"move","path":"/b"}]"""),
)
