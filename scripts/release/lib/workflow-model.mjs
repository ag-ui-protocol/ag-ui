// Test support for workflow tests: a YAML reader for the subset our workflow
// files use, an evaluator for GitHub expressions (`${{ ... }}`, `if:`), and a
// step and job runner. workflow-model.test.ts pins each rule below against
// GitHub's documented behaviour, and checks parseYaml against Psych on every
// workflow in .github/workflows.
//
// The required-checks `changes` job runs its tests without installing
// anything, so this has no dependencies.
//
// It throws on what it does not model: YAML anchors, tags, flow mappings,
// multi-line plain or quoted scalars, explicit block-scalar indentation; any
// shell but bash; a non-literal timeout-minutes; a continue-on-error that is
// not a boolean or a `${{ }}` expression; a missing working-directory;
// unknown expression functions and contexts.
//
// Known gaps that do NOT throw (no workflow here uses them; the Psych parity
// test catches a YAML one that appears):
// - YAML: a folded `>` scalar drops the blank line before a more-indented
//   line; a whitespace-only line in a block scalar loses its spaces; only
//   lowercase true/false/null and decimal numbers are typed (True, 0x10 and
//   .5 stay strings); a plain scalar containing `: ` is accepted.
// - Expressions: context names are case-sensitive, and any key of the ctx
//   object (such as `status`) resolves as a context; a string is compared
//   with a number through JS Number(), so `'0x10' == 16` is true.
// - Runner: see runStep for the env it builds; a handled `uses:` step always
//   succeeds; jobToken does not model the repository's default permissions.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------- YAML

function fail(line, message) {
  throw new Error(`workflow YAML line ${line.no}: ${message}: ${line.raw}`);
}

function unquoteDouble(body, line) {
  return body.replace(/\\(.)/g, (_, c) => {
    const map = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", " ": " " };
    if (!(c in map)) fail(line, `unsupported escape \\${c}`);
    return map[c];
  });
}

function plain(text) {
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  return text;
}

// One scalar on one line, with an optional trailing comment.
function scalar(text, line) {
  const t = text.trim();
  let m;
  if ((m = t.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/)))
    return unquoteDouble(m[1], line);
  if ((m = t.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/)))
    return m[1].replace(/''/g, "'");
  if (/^["']/.test(t)) fail(line, "unterminated or multi-line quoted scalar");
  if (/^[&*!|>]/.test(t)) fail(line, "unsupported YAML node");
  if (t.startsWith("{")) {
    if (/^\{\s*\}\s*(?:#.*)?$/.test(t)) return {};
    fail(line, "flow mappings are not supported");
  }
  if (t.startsWith("[")) {
    const inner = t.match(/^\[(.*)\]\s*(?:#.*)?$/);
    if (!inner) fail(line, "multi-line flow sequence");
    if (inner[1].trim() === "") return [];
    const items = inner[1].match(
      /\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,"'[\]{}]*?)\s*(?:,|$)/gy,
    );
    if (!items || items.join("") !== inner[1])
      fail(line, "unsupported flow sequence");
    return items
      .map((item) => item.replace(/,$/, "").trim())
      .filter((item, i, all) => item !== "" || i < all.length - 1)
      .map((item) => (/^["']/.test(item) ? scalar(item, line) : plain(item)));
  }
  // A plain scalar ends at ` #`.
  return plain(t.replace(/\s+#.*$/, ""));
}

const KEY =
  /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-?:,[\]{}&*!|>%@`][^#]*?|-[^\s][^#]*?):(?:\s+|$)(.*)$/;

function splitKey(content) {
  const m = content.match(KEY);
  if (!m) return null;
  let key = m[1];
  if (key.startsWith('"')) key = JSON.parse(key);
  else if (key.startsWith("'")) key = key.slice(1, -1).replace(/''/g, "'");
  return { key, rest: m[2] };
}

export function parseYaml(text) {
  // A final newline ends the last line; it does not start an empty one.
  const rawLines = text.split("\n");
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "")
    rawLines.pop();
  const lines = rawLines.map((raw, i) => {
    if (/\t/.test(raw.match(/^\s*/)[0]))
      throw new Error(`workflow YAML line ${i + 1}: tab indentation`);
    const content = raw.trimStart();
    return {
      no: i + 1,
      raw,
      indent: raw.length - content.length,
      content,
      blank: content === "" || content.startsWith("#"),
    };
  });
  let pos = 0;
  const peek = () => {
    while (pos < lines.length && lines[pos].blank) pos++;
    return lines[pos];
  };

  function blockScalar(indicator, parentIndent, line) {
    const m = indicator.match(/^([|>])([-+]?)\s*(?:#.*)?$/);
    if (!m) fail(line, "unsupported block scalar header");
    const [, style, chomp] = m;
    const body = [];
    let indent = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.content === "") {
        body.push("");
        pos++;
        continue;
      }
      if (indent === null) {
        if (l.indent <= parentIndent) break;
        indent = l.indent;
      }
      if (l.indent < indent) break;
      body.push(l.raw.slice(indent));
      pos++;
    }
    // Trailing empty lines: dropped, except that keep (`+`) keeps them.
    let trailing = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trailing++;
    }
    if (body.length === 0) return chomp === "+" ? "\n".repeat(trailing) : "";
    let out;
    if (style === "|") out = body.join("\n");
    else {
      out = "";
      for (let i = 0; i < body.length; i++) {
        const cur = body[i];
        if (i === 0) {
          out = cur;
          continue;
        }
        const prev = body[i - 1];
        const moreIndented = (s) => /^\s/.test(s);
        if (cur === "") out += "\n";
        else if (prev === "" || moreIndented(cur) || moreIndented(prev))
          out += (prev === "" ? "" : "\n") + cur;
        else out += " " + cur;
      }
    }
    if (chomp === "-") return out;
    if (chomp === "+") return out + "\n" + "\n".repeat(trailing);
    return out + "\n";
  }

  // The value after `key:` or `- `, whose node starts at `indent`.
  function value(rest, indent, line) {
    const r = rest.replace(/^\s+/, "");
    if (r === "" || r.startsWith("#")) {
      const next = peek();
      if (!next) return null;
      if (next.indent > indent) return node(next.indent);
      if (next.indent === indent && /^-(\s|$)/.test(next.content))
        return node(indent);
      return null;
    }
    if (/^[|>]/.test(r)) return blockScalar(r, indent, line);
    const v = scalar(r, line);
    const next = peek();
    if (next && next.indent > indent && typeof v === "string")
      fail(next, "multi-line plain scalar");
    return v;
  }

  function node(indent) {
    const first = peek();
    if (!first || first.indent !== indent) return null;
    if (/^-(\s|$)/.test(first.content)) {
      const out = [];
      for (let l = peek(); l && l.indent === indent; l = peek()) {
        if (!/^-(\s|$)/.test(l.content)) fail(l, "mapping key in a sequence");
        const rest = l.content.slice(1);
        const lead = rest.length - rest.trimStart().length;
        const item = rest.trimStart();
        if (item !== "" && !item.startsWith("#") && splitKey(item)) {
          // `- key: value` starts a mapping at the column of `key`.
          const col = indent + 1 + lead;
          lines[pos] = { ...l, indent: col, content: item };
          out.push(node(col));
        } else {
          pos++;
          out.push(value(item, indent, l));
        }
      }
      return out;
    }
    const out = {};
    for (let l = peek(); l && l.indent === indent; l = peek()) {
      if (/^-(\s|$)/.test(l.content)) break;
      const kv = splitKey(l.content);
      if (!kv) fail(l, "expected `key: value`");
      if (Object.hasOwn(out, kv.key)) fail(l, `duplicate key ${kv.key}`);
      pos++;
      out[kv.key] = value(kv.rest, indent, l);
    }
    return out;
  }

  const first = peek();
  if (!first) return null;
  const doc = node(first.indent);
  const left = peek();
  if (left) fail(left, "unexpected indentation");
  return doc;
}

// ------------------------------------------------------- expressions

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new Error(`unterminated string: ${src}`);
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      tokens.push({ t: "lit", v: s });
      i = j + 1;
      continue;
    }
    const op = src.slice(i).match(/^(==|!=|<=|>=|&&|\|\||[<>!().,[\]*])/);
    if (op) {
      tokens.push({ t: "op", v: op[1] });
      i += op[1].length;
      continue;
    }
    const num = src.slice(i).match(/^-?\d+(?:\.\d+)?/);
    if (num) {
      tokens.push({ t: "lit", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
    if (id) {
      const w = id[0];
      if (w === "true" || w === "false")
        tokens.push({ t: "lit", v: w === "true" });
      else if (w === "null") tokens.push({ t: "lit", v: null });
      else tokens.push({ t: "id", v: w });
      i += w.length;
      continue;
    }
    throw new Error(`unexpected '${c}' in expression: ${src}`);
  }
  return tokens;
}

function toNumber(v) {
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
  return NaN;
}

function truthy(v) {
  return !(v === false || v === null || v === "" || v === 0 || Number.isNaN(v));
}

// GitHub compares strings ignoring case and coerces mismatched types to
// numbers; objects and arrays are equal only to themselves.
function equal(a, b) {
  if (typeof a === "string" && typeof b === "string")
    return a.toLowerCase() === b.toLowerCase();
  if (
    typeof a === typeof b &&
    (typeof a !== "object" || a === null || b === null)
  )
    return a === b;
  if (typeof a === "object" && a !== null) return a === b;
  if (typeof b === "object" && b !== null) return false;
  return toNumber(a) === toNumber(b);
}

export function toStringValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(v, null, 2);
}

function index(obj, key) {
  if (obj === null || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    return typeof key === "number" ? (obj[key] ?? null) : null;
  }
  const want = String(key).toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === want) return obj[k];
  return null;
}

const STATUS = new Set(["always", "success", "failure", "cancelled"]);

// ctx: { github, inputs, needs, steps, env, secrets, matrix, job, ... }
// plus `status` ('success' | 'failure' | 'cancelled', default 'success').
export function evaluate(src, ctx) {
  const tokens = tokenize(src);
  let p = 0;
  const peekTok = () => tokens[p];
  const eat = (v) => {
    const t = tokens[p];
    if (!t || t.t !== "op" || t.v !== v)
      throw new Error(`expected '${v}' in expression: ${src}`);
    p++;
  };
  const isOp = (v) => tokens[p]?.t === "op" && tokens[p].v === v;
  const status = ctx.status ?? "success";
  // False while parsing the side of `&&` / `||` that GitHub does not
  // evaluate: it is still parsed (so syntax and names are checked), but no
  // function is called and every value reads as null.
  let live = true;
  const functions = {
    always: () => true,
    success: () => status === "success",
    failure: () => status === "failure",
    cancelled: () => status === "cancelled",
    // One pass over the format string only: `{{` and `}}` are literal
    // braces, `{N}` is an argument, and any other brace is an error.
    format: (fmt, ...args) =>
      toStringValue(fmt).replace(/\{\{|\}\}|\{(\d+)\}|[{}]/g, (m, n) => {
        if (m === "{{") return "{";
        if (m === "}}") return "}";
        if (n === undefined || Number(n) >= args.length)
          throw new Error(`invalid format string: ${toStringValue(fmt)}`);
        return toStringValue(args[Number(n)]);
      }),
    contains: (hay, needle) =>
      Array.isArray(hay)
        ? hay.some((x) => equal(x, needle))
        : toStringValue(hay)
            .toLowerCase()
            .includes(toStringValue(needle).toLowerCase()),
    startsWith: (s, x) =>
      toStringValue(s).toLowerCase().startsWith(toStringValue(x).toLowerCase()),
    endsWith: (s, x) =>
      toStringValue(s).toLowerCase().endsWith(toStringValue(x).toLowerCase()),
    toJSON: (v) => JSON.stringify(v, null, 2),
    fromJSON: (v) => JSON.parse(toStringValue(v)),
  };

  function primary() {
    const t = tokens[p++];
    if (!t) throw new Error(`unexpected end of expression: ${src}`);
    if (t.t === "lit") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = or();
      eat(")");
      return v;
    }
    if (t.t === "id") {
      if (isOp("(")) {
        const name = Object.keys(functions).find(
          (f) => f.toLowerCase() === t.v.toLowerCase(),
        );
        if (!name) throw new Error(`unknown function ${t.v} in: ${src}`);
        p++;
        const args = [];
        if (!isOp(")")) {
          args.push(or());
          while (isOp(",")) {
            p++;
            args.push(or());
          }
        }
        eat(")");
        return live ? functions[name](...args) : null;
      }
      if (
        !Object.hasOwn(ctx, t.v) &&
        ![
          "github",
          "inputs",
          "needs",
          "steps",
          "env",
          "secrets",
          "matrix",
          "job",
          "runner",
          "vars",
          "strategy",
        ].includes(t.v)
      )
        throw new Error(`unknown context ${t.v} in: ${src}`);
      return live ? (ctx[t.v] ?? null) : null;
    }
    throw new Error(`unexpected '${t.v}' in expression: ${src}`);
  }
  function postfix() {
    let v = primary();
    for (;;) {
      if (isOp(".")) {
        p++;
        const t = tokens[p++];
        if (!t || t.t !== "id") throw new Error(`bad property in: ${src}`);
        v = index(v, t.v);
      } else if (isOp("[")) {
        p++;
        const k = or();
        eat("]");
        v = index(v, k);
      } else return v;
    }
  }
  function unary() {
    if (isOp("!")) {
      p++;
      return !truthy(unary());
    }
    return postfix();
  }
  function compare() {
    let v = unary();
    for (;;) {
      const t = peekTok();
      if (t?.t !== "op" || !["==", "!=", "<", "<=", ">", ">="].includes(t.v))
        return v;
      p++;
      const r = unary();
      if (t.v === "==") v = equal(v, r);
      else if (t.v === "!=") v = !equal(v, r);
      else {
        const [a, b] =
          typeof v === "string" && typeof r === "string"
            ? [v.toLowerCase(), r.toLowerCase()]
            : [toNumber(v), toNumber(r)];
        v =
          t.v === "<"
            ? a < b
            : t.v === "<="
              ? a <= b
              : t.v === ">"
                ? a > b
                : a >= b;
      }
    }
  }
  // `a && b` is a when a is falsy, else b; `a || b` is a when a is truthy,
  // else b. The operand not taken is not evaluated.
  function shortCircuit(op, operand, takeRight) {
    let v = operand();
    while (isOp(op)) {
      p++;
      const outer = live;
      const right = takeRight(v);
      live = outer && right;
      const r = operand();
      live = outer;
      if (right) v = r;
    }
    return v;
  }
  const and = () => shortCircuit("&&", compare, (v) => truthy(v));
  const or = () => shortCircuit("||", and, (v) => !truthy(v));
  const result = or();
  if (p !== tokens.length) throw new Error(`trailing tokens in: ${src}`);
  return result;
}

// A string field that may hold `${{ }}` templates, rendered as GitHub does.
export function render(value, ctx) {
  if (typeof value !== "string") return toStringValue(value);
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) =>
    toStringValue(evaluate(expr, ctx)),
  );
}

// A job or step `if:`. Without a status function GitHub adds `success() &&`.
export function condition(value, ctx) {
  if (value === undefined || value === null)
    return (ctx.status ?? "success") === "success";
  let expr = String(value).trim();
  const whole = expr.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (whole) expr = whole[1];
  const usesStatus = tokenize(expr).some(
    (t, i, all) =>
      t.t === "id" &&
      STATUS.has(t.v.toLowerCase()) &&
      all[i + 1]?.t === "op" &&
      all[i + 1].v === "(",
  );
  const v = evaluate(expr, ctx);
  return usesStatus
    ? truthy(v)
    : (ctx.status ?? "success") === "success" && truthy(v);
}

// Every `env:` entry of a step (or job), rendered.
export function renderEnv(env, ctx) {
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([k, v]) => [k, render(v, ctx)]),
  );
}

// `key=value` lines of a GITHUB_OUTPUT file (no heredoc values).
export function parseOutputs(text) {
  const out = {};
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/);
    if (!m) throw new Error(`unparseable GITHUB_OUTPUT line: ${line}`);
    out[m[1]] = m[2];
  }
  return out;
}

export function stepNamed(job, name) {
  const found = (job.steps ?? []).filter((s) => s.name === name);
  if (found.length !== 1)
    throw new Error(
      `expected exactly one step '${name}', found ${found.length}`,
    );
  return found[0];
}

// ------------------------------------------------------------ runners

// A step's `shell` or `working-directory`: its own key, else the job's
// `defaults.run`, else the workflow's `defaults.run`.
function runDefault(step, job, workflow, key) {
  return step[key] ?? job.defaults?.run?.[key] ?? workflow.defaults?.run?.[key];
}

// The command line GitHub uses for a `run:` step on Linux and macOS: with no
// `shell:` anywhere it is `bash -e {0}` (no pipefail); an explicit
// `shell: bash` is `bash --noprofile --norc -eo pipefail {0}`. Any other shell
// is not modelled.
function shellArgs(shell, file) {
  if (shell === undefined) return ["bash", ["-e", file]];
  if (shell === "bash")
    return ["bash", ["--noprofile", "--norc", "-eo", "pipefail", file]];
  throw new Error(`unsupported shell ${shell}`);
}

// The `env` context before a step's own `env:`: the workflow's `env:`, then
// the job's, each rendered (the job's wins).
export function envContext(workflow, job, ctx) {
  const outer = renderEnv(workflow.env, ctx);
  return { ...outer, ...renderEnv(job.env, { ...ctx, env: outer }) };
}

// A step's `continue-on-error`: a boolean, or a `${{ }}` expression that must
// give a boolean. Anything else is not modelled.
function continueOnError(step, ctx) {
  const value = step["continue-on-error"];
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  const whole =
    typeof value === "string" && value.trim().match(/^\$\{\{([\s\S]*)\}\}$/);
  if (whole) {
    const v = evaluate(whole[1], ctx);
    if (typeof v === "boolean") return v;
    throw new Error(
      `step '${step.name}': continue-on-error gave ${JSON.stringify(v)}, not a boolean`,
    );
  }
  throw new Error(
    `step '${step.name}': continue-on-error ${JSON.stringify(value)} is not a boolean or a \${{ }} expression`,
  );
}

// No modelled step takes this long. A step that does is a harness fault (a
// fake that never returns), so it throws instead of hanging the suite.
const HARNESS_TIMEOUT_MS = 120_000;

// Runs one `run:` step as the runner does, within this model:
// - the shell from the step, job or workflow (see shellArgs);
// - env: the runner's GITHUB_* subset below, PATH (with `bin` first, for
//   fake tools) and HOME from this process, `extra`, then the workflow, job
//   and step `env:`, rendered; nothing else from this process;
// - `${{ }}` in the script rendered first, with that env as the env context;
// - the working-directory from the step, job or workflow, relative to `cwd`
//   (it must exist);
// - `timeoutMs` stands in for `timeout-minutes` (a literal timeout-minutes
//   under the harness limit is applied as is): a step that reaches it is
//   killed and returns `timedOut: true` with a null status.
// Not modelled: GITHUB_ENV, GITHUB_PATH, GITHUB_WORKSPACE, GITHUB_EVENT_*,
// and other runner variables. A spawn failure throws.
export function runStep(
  step,
  ctx,
  { workflow, job, bin, cwd = process.cwd(), env: extra = {}, timeoutMs } = {},
) {
  if (!workflow || !job)
    throw new Error(
      `runStep '${step.name}': pass the workflow and job the step belongs to (their env and defaults apply)`,
    );
  if (typeof step.run !== "string")
    throw new Error(`step '${step.name}' has no run`);
  if (ctx.env !== undefined)
    throw new Error(
      "ctx.env is built from the workflow, job and step env; do not pass it",
    );
  const outer = envContext(workflow, job, ctx);
  const stepEnv = renderEnv(step.env, { ...ctx, env: outer });
  const sctx = { ...ctx, env: { ...outer, ...stepEnv } };
  const script = render(step.run, sctx);
  const shell = runDefault(step, job, workflow, "shell");
  let workdir = cwd;
  const wd = runDefault(step, job, workflow, "working-directory");
  if (wd !== undefined) {
    workdir = resolve(cwd, render(wd, sctx));
    if (!existsSync(workdir) || !statSync(workdir).isDirectory())
      throw new Error(
        `step '${step.name}': working-directory ${workdir} does not exist`,
      );
  }
  const minutes = step["timeout-minutes"];
  if (minutes !== undefined && typeof minutes !== "number")
    throw new Error(
      `step '${step.name}': only a literal timeout-minutes is modelled`,
    );
  let limit = timeoutMs;
  if (limit === undefined && minutes !== undefined)
    if (minutes * 60_000 < HARNESS_TIMEOUT_MS) limit = minutes * 60_000;
  const tmp = mkdtempSync(join(tmpdir(), "wf-step-"));
  try {
    const file = join(tmp, "step.sh");
    writeFileSync(file, script);
    const output = join(tmp, "output");
    const summary = join(tmp, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const github = ctx.github ?? {};
    const env = {
      PATH: `${bin ? `${bin}:` : ""}${process.env.PATH}`,
      HOME: process.env.HOME,
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: github.repository ?? "",
      GITHUB_REF: github.ref ?? "",
      GITHUB_REF_NAME: github.ref_name ?? "",
      GITHUB_SHA: github.sha ?? "",
      GITHUB_RUN_ID: String(github.run_id ?? ""),
      GITHUB_RUN_ATTEMPT: String(github.run_attempt ?? ""),
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: tmp,
      ...extra,
      ...sctx.env,
    };
    const [cmd, args] = shellArgs(shell, file);
    const r = spawnSync(cmd, args, {
      cwd: workdir,
      env,
      encoding: "utf8",
      timeout: limit ?? HARNESS_TIMEOUT_MS,
    });
    const timedOut = r.error?.code === "ETIMEDOUT";
    if (timedOut && limit === undefined)
      throw new Error(
        `step '${step.name}' ran past the ${HARNESS_TIMEOUT_MS} ms harness limit; pass timeoutMs to model its timeout`,
      );
    if (r.error && !timedOut) throw r.error;
    return {
      status: r.status,
      signal: r.signal,
      timedOut,
      stdout: r.stdout,
      stderr: r.stderr,
      env,
      outputs: parseOutputs(readFileSync(output, "utf8")),
      summary: readFileSync(summary, "utf8"),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const APP_TOKEN_ACTION = /^actions\/create-github-app-token@/;

// The token a create-github-app-token step would return, encoded so a fake
// `gh` can tell which permissions it carries: `app:contents=write,...`.
export function appToken(step) {
  const perms = Object.entries(step.with ?? {})
    .filter(([k]) => k.startsWith("permission-"))
    .map(([k, v]) => `${k.slice("permission-".length)}=${v}`)
    .sort();
  return `app:${perms.join(",")}`;
}

// The job's GITHUB_TOKEN, encoded the same way from its `permissions:`.
export function jobToken(workflow, job) {
  const perms = job.permissions ?? workflow.permissions ?? {};
  if (typeof perms !== "object")
    throw new Error("only mapping permissions are modelled");
  return `job:${Object.entries(perms)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(",")}`;
}

// Runs a job's steps in order with GitHub's step-skipping rules. `run:` steps
// execute through runStep; create-github-app-token steps yield appToken(step),
// or fail with no token when `mintFails(step)` is true; any other `uses:` step
// needs a `uses(step)` handler (its return value is the step's outputs), or it
// throws. A handled `uses:` step always succeeds. `timeoutMs(step)` gives a
// step's runStep timeoutMs.
export function runJob(
  workflow,
  job,
  ctx,
  { bin, cwd, uses, mintFails = () => false, timeoutMs = () => undefined } = {},
) {
  const steps = {};
  const log = [];
  let status = "success";
  for (const step of job.steps) {
    const sctx = { ...ctx, steps, status };
    const cctx = { ...sctx, env: envContext(workflow, job, sctx) };
    if (!condition(step.if, cctx)) {
      log.push({ step, ran: false });
      if (step.id)
        steps[step.id] = {
          outputs: {},
          outcome: "skipped",
          conclusion: "skipped",
        };
      continue;
    }
    const continues = continueOnError(step, cctx);
    let result;
    if (step.uses && APP_TOKEN_ACTION.test(step.uses)) {
      result = mintFails(step)
        ? { status: 1, stdout: "", stderr: "mint failed", outputs: {} }
        : {
            status: 0,
            stdout: "",
            stderr: "",
            outputs: { token: appToken(step) },
          };
    } else if (step.uses) {
      if (!uses) throw new Error(`no handler for uses: ${step.uses}`);
      result = {
        status: 0,
        stdout: "",
        stderr: "",
        outputs: uses(step, cctx) ?? {},
      };
    } else {
      result = runStep(step, sctx, {
        workflow,
        job,
        bin,
        cwd,
        timeoutMs: timeoutMs(step),
      });
    }
    const outcome = result.status === 0 ? "success" : "failure";
    const conclusion = outcome === "failure" && continues ? "success" : outcome;
    if (step.id)
      steps[step.id] = { outputs: result.outputs, outcome, conclusion };
    if (conclusion === "failure") status = "failure";
    log.push({ step, ran: true, ...result, outcome });
  }
  return { status, steps, log };
}
