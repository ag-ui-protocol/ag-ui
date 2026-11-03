// Test support for workflow tests: a YAML reader for the subset our workflow
// files use, and an evaluator for GitHub expressions (`${{ ... }}`, `if:`).
//
// No YAML parser is installed in the root, and the required-checks `changes`
// job runs its tests without installing anything, so this has no
// dependencies. It fails loudly on YAML it does not support (anchors, tags,
// flow mappings, multi-line plain scalars) instead of guessing.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const lines = text.split("\n").map((raw, i) => {
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
    while (body.length && body[body.length - 1] === "") body.pop();
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
    if (body.length === 0) return "";
    return chomp === "-" ? out : out + "\n";
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
  const functions = {
    always: () => true,
    success: () => status === "success",
    failure: () => status === "failure",
    cancelled: () => status === "cancelled",
    format: (fmt, ...args) =>
      toStringValue(fmt)
        .replace(/\{(\d+)\}/g, (_, n) => toStringValue(args[Number(n)]))
        .replace(/\{\{/g, "{")
        .replace(/\}\}/g, "}"),
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
        return functions[name](...args);
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
      return ctx[t.v] ?? null;
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
  function and() {
    let v = compare();
    while (isOp("&&")) {
      p++;
      const r = compare();
      v = truthy(v) ? r : v;
    }
    return v;
  }
  function or() {
    let v = and();
    while (isOp("||")) {
      p++;
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  }
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

// The command line GitHub uses for a `run:` step on Linux and macOS.
function shellArgs(shell, file) {
  if (shell === undefined) return ["bash", ["-e", file]];
  if (shell === "bash")
    return ["bash", ["--noprofile", "--norc", "-eo", "pipefail", file]];
  throw new Error(`unsupported shell ${shell}`);
}

// Runs one `run:` step as the runner would: its `env:` rendered from ctx, the
// runner's default GITHUB_* variables, and nothing else from this process
// except PATH and HOME. `bin` is put first on PATH (for fake tools).
export function runStep(step, ctx, { bin, cwd, shell, env: extra = {} } = {}) {
  if (typeof step.run !== "string")
    throw new Error(`step '${step.name}' has no run`);
  const dir = mkdtempSync(join(tmpdir(), "wf-step-"));
  try {
    const file = join(dir, "step.sh");
    writeFileSync(file, step.run);
    const output = join(dir, "output");
    const summary = join(dir, "summary");
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
      RUNNER_TEMP: dir,
      ...extra,
      ...renderEnv(ctx.jobEnv, ctx),
      ...renderEnv(step.env, ctx),
    };
    const [cmd, args] = shellArgs(step.shell ?? shell, file);
    const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      env,
      outputs: parseOutputs(readFileSync(output, "utf8")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
// execute; create-github-app-token steps yield appToken(step), or fail with no
// token when `mintFails(step)` is true; any other `uses:` step must be handled
// by `uses(step)` (return outputs) or it throws.
export function runJob(
  workflow,
  job,
  ctx,
  { bin, cwd, uses, mintFails = () => false } = {},
) {
  const steps = {};
  const log = [];
  let status = "success";
  for (const step of job.steps) {
    const sctx = { ...ctx, jobEnv: job.env, steps, status };
    if (!condition(step.if, sctx)) {
      log.push({ step, ran: false });
      if (step.id)
        steps[step.id] = {
          outputs: {},
          outcome: "skipped",
          conclusion: "skipped",
        };
      continue;
    }
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
        outputs: uses(step, sctx) ?? {},
      };
    } else {
      result = runStep(step, sctx, {
        bin,
        cwd,
        shell: job.defaults?.run?.shell,
      });
    }
    const outcome = result.status === 0 ? "success" : "failure";
    const conclusion =
      outcome === "failure" && step["continue-on-error"] === true
        ? "success"
        : outcome;
    if (step.id)
      steps[step.id] = { outputs: result.outputs, outcome, conclusion };
    if (conclusion === "failure") status = "failure";
    log.push({ step, ran: true, ...result, outcome });
  }
  return { status, steps, log };
}
