#!/usr/bin/env node
/*
 * #184 AC-5 (pulled forward into #180) — a worker crash can silently drop a whole spec file from
 * vitest's own result without changing its exit code shape (#184 R8): the printed "Test Files" /
 * "Tests" summary lines show a failed+passed+skipped breakdown AND a separately-tracked collected
 * total in parens, e.g. "Test Files  7 failed | 303 passed | 3 skipped (315)" — and when a worker
 * crashes mid-run those two numbers stop agreeing (313 != 315) while vitest prints no error for it
 * beyond an easy-to-miss "Errors 2 errors" line. Confirmed against this repo's actual vitest 2 output
 * (`baseline-run2-flagoff.txt`) before writing this, rather than assumed from the JSON reporter, whose
 * numTotalTestSuites/numPassed.../numFailed... fields are DESCRIBE-BLOCK counts, not file counts, and
 * do not carry the pre-crash collected total at all.
 *
 * #184 AC-4 — the crash itself is root-caused as a Windows child-process-level native fault (see
 * docs/progress/184-vitest-worker-exited-unexpectedly.md): not caused by, or fixable in, test or
 * application code. Since the fault can't be eliminated from here, this wraps detection with
 * automatic recovery: on a reconciliation failure, diff the file list vitest streamed a per-file
 * result line for (every file prints exactly one `<icon> path (N tests) ...` summary line as it
 * finishes, pass or fail — regardless of whether the crash happens later) against the full expected
 * spec glob, and re-run ONLY the files that never printed one. Repeats up to RETRY_BUDGET times
 * before failing loudly (today's behaviour, unchanged, once the budget is exhausted) — targeted
 * retry costs seconds per crash instead of re-running the whole 7-14 minute suite.
 */
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RETRY_BUDGET = 3;

function collectSpecFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectSpecFiles(full, out);
    else if (/\.(spec|e2e-spec)\.ts$/.test(entry)) {
      out.push(relative(process.cwd(), full).split('\\').join('/'));
    }
  }
  return out;
}

function runVitest(fileArgs) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--no-install', 'vitest', 'run', ...fileArgs], { shell: true });
    let combined = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      combined += chunk;
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      combined += chunk;
    });
    child.on('close', (code) => resolve({ code, combined }));
  });
}

/** Parses a vitest summary line: "<label>  <n> failed | <n> passed | <n> skipped (<total>)". Any of
 * the failed/passed/skipped/todo segments may be absent (0). Returns null if the label's line is
 * missing entirely — treated as its own failure below, since a run that never prints its own summary
 * cannot be trusted either. */
function parseSummaryLine(text, label) {
  const lineRe = new RegExp(`^\\s*${label}\\s+(.+?)\\s*\\((\\d+)\\)\\s*$`, 'm');
  const stripped = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const m = stripped.match(lineRe);
  if (!m) return null;
  const [, body, totalStr] = m;
  const grab = (word) => {
    const wm = body.match(new RegExp(`(\\d+)\\s+${word}`));
    return wm ? Number(wm[1]) : 0;
  };
  return {
    total: Number(totalStr),
    failed: grab('failed'),
    passed: grab('passed'),
    skipped: grab('skipped'),
    todo: grab('todo'),
  };
}

/** Every file prints exactly one summary line as it finishes: ` ✓ test/foo.spec.ts (3 tests) 12ms`
 * or ` ❯ test/foo.spec.ts (3 tests | 1 failed) 12ms`. Requiring the "(" right after the path excludes
 * per-test lines (`✓ test/foo.spec.ts > describe > it`) and in-stack-trace file mentions
 * (`❯ test/foo.spec.ts:5:15`), which have no "(" there. */
function parseCompletedFiles(text) {
  const stripped = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const re = /^[ \t]*\S{1,2}\s+(\S+\.(?:e2e-spec|spec)\.ts)\s*\(/gm;
  const files = new Set();
  let m;
  while ((m = re.exec(stripped))) files.add(m[1]);
  return files;
}

function zeroAgg() {
  return { failed: 0, passed: 0, skipped: 0, todo: 0 };
}

async function main() {
  const explicitArgs = process.argv.slice(2);
  const allSpecs = explicitArgs.length > 0 ? explicitArgs : collectSpecFiles(join(process.cwd(), 'test'));

  let remaining = allSpecs;
  let attempt = 0;
  let lastExitCode = 0;
  const aggFiles = zeroAgg();
  const aggTests = zeroAgg();

  while (remaining.length > 0 && attempt < RETRY_BUDGET) {
    attempt += 1;
    if (attempt > 1) {
      console.error(
        `\n#184 AC-4: retry ${attempt - 1}/${RETRY_BUDGET - 1} — re-running ${remaining.length} file(s) a ` +
          `worker crash dropped from the previous attempt: ${remaining.join(', ')}\n`,
      );
    }
    // The full-suite invocation (`pnpm test`, no explicit args) must NOT pass all ~300+ collected
    // paths as CLI args — Windows' command-line length limit ("The command line is too long.") is
    // far below that, and hitting it looks exactly like every file crashing (#184 investigation hit
    // this by accident). Let vitest's own `include` glob resolve the full set; only ever pass an
    // explicit (small) file list on a retry, where `remaining` is the handful of files a crash
    // actually dropped.
    const fileArgs = attempt === 1 && explicitArgs.length === 0 ? [] : remaining;
    const { code, combined } = await runVitest(fileArgs);
    lastExitCode = code ?? 1;

    const files = parseSummaryLine(combined, 'Test Files');
    const tests = parseSummaryLine(combined, 'Tests');
    if (files) for (const k of Object.keys(aggFiles)) aggFiles[k] += files[k];
    if (tests) for (const k of Object.keys(aggTests)) aggTests[k] += tests[k];

    const completed = parseCompletedFiles(combined);
    remaining = remaining.filter((f) => !completed.has(f));
  }

  const totalExpected = allSpecs.length;
  const reportedFiles = aggFiles.failed + aggFiles.passed + aggFiles.skipped + aggFiles.todo;

  const problems = [];
  if (remaining.length > 0) {
    problems.push(
      `${remaining.length} file(s) never produced a result after ${attempt} attempt(s): ${remaining.join(', ')}.`,
    );
  }
  // Safety net independent of the per-file diff above: even if every file matched a completed-file
  // line, cross-check against vitest's own reported totals in case a file's line was mis-parsed.
  if (reportedFiles !== totalExpected) {
    problems.push(`files: reconciled ${reportedFiles} across all attempts, but expected ${totalExpected}.`);
  }

  if (problems.length > 0) {
    console.error(`\nSUITE INCOMPLETE after ${attempt} attempt(s) — do not trust this run:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('  A worker crash (#184) survived every retry — see docs/progress/184-*.md.');
    process.exit(1);
  }

  if (attempt > 1) {
    console.error(
      `\n#184 AC-4: recovered — all ${totalExpected} files accounted for after ${attempt} attempts ` +
        `(${attempt - 1} crash-triggered retr${attempt - 1 === 1 ? 'y' : 'ies'}).`,
    );
  }

  process.exit(aggFiles.failed > 0 || aggTests.failed > 0 ? 1 : lastExitCode);
}

main();
