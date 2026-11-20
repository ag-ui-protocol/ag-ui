# PNI-568 historical orphan fixture

`pni-568-orphan.json` is the minimal three-message orphan window from the saved
LangGraph thread `01a0fb8f-081d-7000-8000-0ca1753dd729`. The synthetic demo data,
original message IDs, malformed arguments and trailing
user message are preserved. The unanswered call is
`call_25dQx1aDND8JEi4wmPYlEQ6z` (`render_a2ui`).

Source capture: `ts-snapshot-now.json` from the PNI-558/PNI-568 parity validation,
entry for that native thread, `values.messages`. Unrelated conversation turns, generated UI source, and provider metadata are omitted. No tool outcome has been added
to this fixture. Tests must supply a truthful recovery outcome separately.

The native regression inserts that supplied outcome before the already saved
follow-up without losing any existing message. Middleware tests cover replay,
reopening, frontend/native approval boundaries, and catalog validation of the
exact malformed arguments.
