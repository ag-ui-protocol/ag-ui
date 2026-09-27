"""Unit tests for StreamedToolArgs (PartialArg chunks -> TOOL_CALL_ARGS deltas)."""

import json

from google.genai import types

from ag_ui_adk.streamed_tool_args import StreamedToolArgs, parse_json_path


def _pa(path, **value):
    return types.PartialArg(json_path=path, **value)


def _run(chunks, final):
    s = StreamedToolArgs("id-1", "tool")
    deltas = [s.apply(c) for c in chunks]
    deltas.append(s.finish(final))
    return [d for d in deltas if d]


def test_parse_json_path_variants():
    assert parse_json_path("$.a.b[0].c") == ["a", "b", 0, "c"]
    assert parse_json_path("$['weird key'].x") == ["weird key", "x"]
    assert parse_json_path("$['it\\'s']") == ["it's"]
    assert parse_json_path("$.tags[12]") == ["tags", 12]


def test_string_fragments_stream_and_join_to_final():
    final = {"title": "Hello world", "body": "abc"}
    deltas = _run(
        [
            [_pa("$.title", string_value="Hel")],
            [_pa("$.title", string_value="lo ")],
            [_pa("$.title", string_value="world")],
            [_pa("$.body", string_value="ab")],
            [_pa("$.body", string_value="c")],
        ],
        final,
    )
    assert len(deltas) >= 5
    assert json.loads("".join(deltas)) == final


def test_nested_arrays_objects_and_scalars():
    final = {
        "sections": [
            {"heading": "A", "points": ["x", "y"]},
            {"heading": "B", "points": []},
        ],
        "count": 2,
        "ratio": 0.5,
        "ok": False,
        "none": None,
        "weird key": "v",
    }
    deltas = _run(
        [
            [_pa("$.sections[0].heading", string_value="A")],
            [_pa("$.sections[0].points[0]", string_value="x")],
            [_pa("$.sections[0].points[1]", string_value="y")],
            [_pa("$.sections[1].heading", string_value="B")],
            [
                _pa("$.sections[1].points")
            ],  # empty list: valueless PartialArg -> degrade
            [_pa("$.count", number_value=2.0)],
        ],
        final,
    )
    assert json.loads("".join(deltas)) == final


def test_whole_numbers_render_as_ints_and_escapes_survive():
    final = {"n": 3, "s": 'quote " backslash \\ newline \n unicode é'}
    deltas = _run(
        [
            [_pa("$.n", number_value=3.0)],
            [_pa("$.s", string_value='quote " back')],
            [_pa("$.s", string_value="slash \\ newline \n unicode é")],
        ],
        final,
    )
    joined = "".join(deltas)
    assert '"n":3' in joined
    assert json.loads(joined) == final


def test_every_emitted_prefix_is_a_prefix_of_the_final_json():
    final = {"a": "xyz", "b": [1, 2], "c": {"d": True}}
    s = StreamedToolArgs("id", "t")
    for chunk in (
        [_pa("$.a", string_value="x")],
        [_pa("$.a", string_value="yz")],
        [_pa("$.b[0]", number_value=1.0)],
        [_pa("$.b[1]", number_value=2.0)],
        [_pa("$.c.d", bool_value=True)],
    ):
        s.apply(chunk)
        assert '{"a":"xyz","b":[1,2],"c":{"d":true}}'.startswith(s.emitted)
    s.finish(final)
    assert json.loads(s.emitted) == final


def test_stream_cut_short_is_closed_into_valid_json():
    s = StreamedToolArgs("id", "t")
    s.apply([_pa("$.title", string_value="Half a ti")])
    s.finish(None)
    assert json.loads(s.emitted) == {"title": "Half a ti"}


def test_no_partial_args_emits_nothing_until_final():
    s = StreamedToolArgs("id", "t")
    assert s.apply(None) == ""
    assert s.apply([]) == ""
    assert s.finish({"x": 1}) == '{"x":1}'
