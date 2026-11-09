/**
 * Turning a build log into something a small model can act on.
 *
 * This file exists because of the lesson WATCHERS.md already draws from `weather_alerts`:
 * *the tool does the arithmetic, the model does the prose, and neither is asked to do the
 * other's job.* A `run_command` that hands back 4,000 lines of `cargo` output has asked the
 * model to do the arithmetic — find the first error in a wall of text, on a 3B-active local
 * model, with the context window as the binding constraint. It will sometimes find it.
 *
 * So each parser here reduces a known output format to the two facts that drive the next
 * step: **did it pass, and if not, what is the FIRST thing that broke.** The raw output is
 * never thrown away — `run_command` still clips it through `stash.ts`, so the model can
 * read on when the summary is not enough. What changes is what it reads first.
 *
 * A format with no parser gets `generic`, which is not a failure mode: error-ish lines
 * first, then the tail, because nearly every build tool puts its verdict at the end.
 *
 * ## Why parsers take text and return text
 *
 * No parser here touches the filesystem, spawns anything, or knows what a policy is. They
 * are pure string functions, which is what makes them testable without a repo and safe to
 * point at hostile input — and the input IS hostile: a dependency's name, a test fixture's
 * contents and a panic message are all attacker-influenceable in a repo with third-party
 * code. Nothing here interprets what it reads; it only decides which lines to show.
 */

/** What `run_command` observed. Shaped by the tool, consumed by the parsers. */
export interface CommandResult {
  /** Process exit code, or null when it was killed by a signal. */
  code: null | number;
  signal: null | string;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.trim() !== "");

/** Both streams, in the order a person reading a terminal would have seen them. */
const combined = (r: CommandResult): string[] => [...lines(r.stdout), ...lines(r.stderr)];

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Trim a line that would otherwise paste a minified bundle into the context. */
const short = (s: string, max = 300): string => (s.length > max ? `${s.slice(0, max)}…` : s.trim());

/**
 * `cargo … --message-format=json`: newline-delimited JSON, one object per diagnostic.
 *
 * Only `compiler-message` objects carry a diagnostic, and only `message.level` says how bad
 * it is. `message.rendered` is the human text rustc would have printed, which is already the
 * best single-string summary of a Rust error in existence — so this parser's whole job is to
 * find the first one with `level: "error"` and show that, rather than re-deriving it from
 * spans.
 *
 * A line that is not JSON is skipped rather than fatal: `cargo test` interleaves the test
 * harness's plain-text output with the JSON stream, and a parser that threw on the first
 * non-JSON line would report "no errors" on a failing build.
 */
export const parseCargoJson = (r: CommandResult): null | string => {
  const errors: string[] = [];
  let warnings = 0;

  for (const line of lines(r.stdout)) {
    if (!line.startsWith("{")) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.reason !== "compiler-message") continue;
    const level = obj?.message?.level;
    if (level === "warning") warnings++;
    if (level !== "error") continue;
    const span = obj?.message?.spans?.find((s: any) => s?.is_primary) ?? obj?.message?.spans?.[0];
    const where = span?.file_name ? `${span.file_name}:${span.line_start}` : "(no location)";
    errors.push(`${where}  ${short(String(obj?.message?.message ?? ""))}`);
  }

  // The harness prints this itself, and it is the only place a *test* failure (as opposed to
  // a compile failure) is counted — a crate can compile cleanly and still fail its tests.
  const testLine = combined(r).find((l) => /^test result:/.test(l.trim()));

  if (!errors.length && !testLine) return null;

  const parts: string[] = [];
  if (errors.length) {
    parts.push(`${plural(errors.length, "compile error")}:`);
    parts.push(...errors.slice(0, 5).map((e) => `  ${e}`));
    if (errors.length > 5) parts.push(`  …and ${errors.length - 5} more`);
  }
  if (testLine) parts.push(testLine.trim());
  if (warnings) parts.push(`${plural(warnings, "warning")}.`);
  return parts.join("\n");
};

/**
 * `tsc --noEmit`: `src/foo.ts(12,3): error TS2345: Argument of type …`
 *
 * One diagnostic per line and no summary line worth reading, so the count has to be derived
 * here. The first few are what matter: a type error early in a file routinely produces a
 * dozen downstream ones that vanish when it is fixed, which is also why the model is told to
 * fix the first and re-run rather than work the list.
 */
export const parseTsc = (r: CommandResult): null | string => {
  const diags = combined(r).filter((l) => /\(\d+,\d+\): error TS\d+:/.test(l));
  if (!diags.length) return null;
  const head = diags.slice(0, 5).map((l) => `  ${short(l.trim())}`);
  return [
    `${plural(diags.length, "type error")}:`,
    ...head,
    diags.length > 5 ? `  …and ${diags.length - 5} more` : "",
    "Fix the first one and re-run — later errors are often downstream of it.",
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * ESLint's default `stylish` formatter: a bare path, then indented `line:col  level  msg  rule`
 * rows, then a `✖ N problems` summary. The summary is the cheapest thing to trust, so it is
 * preferred when present and reconstructed from the rows when it is not.
 */
export const parseEslint = (r: CommandResult): null | string => {
  const all = combined(r);
  const summary = all.find((l) => /\d+\s+problems?\s*\(/.test(l));
  const rows = all.filter((l) => /^\s+\d+:\d+\s+(error|warning)\s/.test(l));
  if (!summary && !rows.length) return null;

  // A bare path line immediately above a row is the file those rows belong to.
  const firsts: string[] = [];
  let file = "";
  for (const l of all) {
    if (/^\//.test(l.trim()) || /^[\w./-]+\.[a-z]+$/.test(l.trim())) file = l.trim();
    if (/^\s+\d+:\d+\s+error\s/.test(l) && firsts.length < 5) firsts.push(`  ${file}${file ? " " : ""}${short(l.trim(), 160)}`);
  }

  return [summary ? summary.trim() : `${plural(rows.length, "lint problem")}.`, ...firsts].join("\n");
};

/**
 * TAP, and the PASS/FAIL shape this repo's own `test/*.test.mjs` files print.
 *
 * Two formats in one parser because they answer the same question and a run of `npm test`
 * here emits the second. `not ok` is TAP's failure marker; a line whose first word is `FAIL`
 * is this project's.
 */
export const parseTap = (r: CommandResult): null | string => {
  const all = combined(r);
  const notOk = all.filter((l) => /^not ok\b/.test(l.trim()));
  const fails = all.filter((l) => /^FAIL\b/.test(l.trim()));
  const failing = [...notOk, ...fails];
  if (!failing.length) return null;
  return [
    `${plural(failing.length, "failing assertion")}:`,
    ...failing.slice(0, 8).map((l) => `  ${short(l.trim(), 200)}`),
    failing.length > 8 ? `  …and ${failing.length - 8} more` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * `xcodebuild`: the worst case in the set — thousands of lines in which four matter.
 *
 * ## What capturing real output changed
 *
 * The first version of this parser filtered for lines containing `error:`, which
 * double-counts every single diagnostic. Modern Swift echoes each one into a source snippet
 * that repeats the message:
 *
 * ```
 * Sources/Demo/main.swift:1:14: error: cannot convert value of type 'String' to specified type 'Int'
 * 1 | let n: Int = "not an int"
 *   |              `- error: cannot convert value of type 'String' to specified type 'Int'
 * ```
 *
 * So a diagnostic is only counted from the anchored `file:line:col: error:` form, and gutter
 * lines (`^ *\d* *|`) are dropped. "2 errors" when there is one is not a rounding problem: it
 * sends the loop looking for a second bug that was never there.
 *
 * ## The four kinds of failure are not interchangeable
 *
 * They are reported separately because they have different fixes, and a loop told only
 * "BUILD FAILED" will edit code to fix any of them:
 *
 *   - `xcodebuild: error: …` — the invocation is wrong (no such scheme, no matching
 *     destination). The fix is the DECLARATION in policy.json, never the code, so this is
 *     reported first and says so.
 *   - `file:line:col: error: …` — a real compile error. What the loop should act on.
 *   - a bare `error: …` with no file — signing, provisioning, a missing capability. Extremely
 *     common for an iOS app and not fixable by editing Swift.
 *   - `ld:` / `clang: error:` — linking. Usually a missing file in the target, not a syntax
 *     error anywhere.
 *
 * ## Noise
 *
 * CoreSimulator and DVT write timestamped lines containing the word ERROR to stdout on a
 * perfectly successful build, and on this machine the sandbox makes them write several. They
 * are dropped by shape, which is also why `generic` is the wrong fallback for Xcode: it would
 * confidently report "8 lines mentioning a failure" about a build that compiled.
 *
 * The structural answer to all of this is `-resultBundlePath` plus `xcrun xcresulttool`,
 * which hands back the same facts as JSON. That is a declaration change and a subprocess,
 * and it is NOT implemented here: this sandbox blocks the XPC CoreSimulator needs and
 * refuses the result-bundle write, so it could not be verified on this machine. Left for
 * whoever can run a real build — see docs/PLAN-build-loop.md.
 */
const XC_NOISE = [
  /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ \w+\[\d+:\d+\]/,
  /^\[-\[Sim/,
  /^objc\[\d+\]/,
  /DVTFilePathFSEvents/,
  /^Logging connecton/,
  /^\s*"XPCErrorDescription"/,
];

/** A gutter line from an echoed source snippet, which repeats a diagnostic verbatim. */
const XC_GUTTER = /^\s*(\d+\s*)?\|/;

const XC_DIAGNOSTIC = /^(.+?):(\d+):(\d+): (error|warning): (.+)$/;

export const parseXcodebuild = (r: CommandResult): null | string => {
  const all = combined(r).filter((l) => !XC_NOISE.some((n) => n.test(l)) && !XC_GUTTER.test(l));

  const banner = all.find((l) => /^\*\*\s+(BUILD|TEST|CLEAN|ARCHIVE)\s+(FAILED|SUCCEEDED|INTERRUPTED)/.test(l.trim()));
  const invocation: string[] = [];
  const compile: string[] = [];
  const bare: string[] = [];
  const link: string[] = [];
  const tests: string[] = [];
  let executed = "";
  let warnings = 0;

  for (const raw of all) {
    const line = raw.trim();

    const xc = /^xcodebuild: error: (.+)$/.exec(line);
    if (xc) {
      invocation.push(short(xc[1], 240));
      continue;
    }

    const diag = XC_DIAGNOSTIC.exec(line);
    if (diag) {
      if (diag[4] === "warning") warnings++;
      // The file is shown relative-ish: a DerivedData path is 140 characters of noise.
      else compile.push(`${diag[1].split("/").slice(-2).join("/")}:${diag[2]}:${diag[3]}  ${short(diag[5], 200)}`);
      continue;
    }

    if (/^error: /.test(line)) {
      bare.push(short(line.replace(/^error: /, ""), 240));
      continue;
    }

    if (/^(ld|clang|swiftc): (error|fatal error): /.test(line) || /^ld: /.test(line)) {
      link.push(short(line, 200));
      continue;
    }

    // Both the old Xcode shape and the newer one that names the device.
    if (/^Test ?[Cc]ase .+ failed/.test(line) || /^Test case '.+' failed/.test(line)) {
      tests.push(short(line, 200));
      continue;
    }

    if (/^Executed \d+ test/.test(line)) executed = line;
  }

  const anything = banner || invocation.length || compile.length || bare.length || link.length || tests.length;
  if (!anything) return null;

  const out: string[] = [];
  if (banner) out.push(banner.trim());

  const section = (title: string, rows: string[], cap = 5): void => {
    if (!rows.length) return;
    out.push(title);
    out.push(...rows.slice(0, cap).map((x) => `  ${x}`));
    if (rows.length > cap) out.push(`  …and ${rows.length - cap} more`);
  };

  // First, because the fix is not in the code and a loop told otherwise will edit Swift.
  section(
    `${plural(invocation.length, "problem with the xcodebuild invocation", "problems with the xcodebuild invocation")} — fix the declaration in policy.json, not the code:`,
    invocation,
  );
  section(`${plural(compile.length, "compile error")}:`, compile);
  section(`${plural(bare.length, "build-setting error")} (signing, provisioning, capabilities — not a code change):`, bare);
  section(`${plural(link.length, "link error")}:`, link);
  section(`${plural(tests.length, "failing test")}:`, tests, 8);
  if (executed) out.push(executed);
  if (warnings) out.push(`${plural(warnings, "warning")}.`);

  return out.join("\n");
};
/**
 * No parser for this format. Show the error-ish lines, then the tail.
 *
 * The tail is there because almost every build tool states its verdict last, and the
 * error-ish lines are there because the ones that don't put it first. This is the honest
 * default — it is not pretending to understand the format, and the model still has the full
 * output a `read_more` away.
 */
export const parseGeneric = (r: CommandResult): null | string => {
  const all = combined(r);
  if (!all.length) return null;

  const interesting = all.filter((l) =>
    /\b(error|errors|failed|failure|failing|panicked|exception|cannot find|not found|undefined reference)\b/i.test(l),
  );

  const parts: string[] = [];
  if (interesting.length) {
    parts.push(`lines mentioning a failure (${interesting.length}):`);
    parts.push(...interesting.slice(0, 8).map((l) => `  ${short(l.trim(), 240)}`));
    if (interesting.length > 8) parts.push(`  …and ${interesting.length - 8} more`);
  }

  const tail = all.slice(-12);
  if (tail.length) {
    parts.push(`last ${plural(tail.length, "line")}:`);
    parts.push(...tail.map((l) => `  ${short(l.trim(), 240)}`));
  }
  return parts.join("\n");
};

const PARSERS: Record<string, (r: CommandResult) => null | string> = {
  "cargo-json": parseCargoJson,
  eslint: parseEslint,
  generic: parseGeneric,
  tap: parseTap,
  tsc: parseTsc,
  xcodebuild: parseXcodebuild,
};

export const PARSER_NAMES = Object.keys(PARSERS).sort();

/**
 * Summarise a finished command.
 *
 * The named parser is tried first; `generic` is the fallback whenever the name is unknown or
 * the named parser found nothing it recognised. A parser returning null means "this output
 * is not the format I know", which on a passing build is the normal answer — so a zero exit
 * with no recognised diagnostics summarises to nothing and the caller says `PASSED` on its
 * own.
 */
export const summarise = (parse: string | undefined, r: CommandResult): null | string => {
  if (r.timedOut) return null; // the caller says so; a timed-out log's tail is rarely the cause
  const named = parse ? PARSERS[parse] : undefined;
  const fromNamed = named ? named(r) : null;
  if (fromNamed) return fromNamed;
  // A clean exit needs no summary at all. Only reach for `generic` when something went wrong.
  if (r.code === 0) return null;
  return parseGeneric(r);
};
