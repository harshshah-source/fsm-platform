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
 * This wraps `vitest run`, tees its output live, then parses both summary lines and fails loudly
 * (distinct message, non-zero exit) the moment failed+passed+skipped != collected for either — so the
 * next occurrence is a named failure instead of "the passed count drifted by 7".
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const child = spawn('npx', ['--no-install', 'vitest', 'run', ...args], { shell: true });

let combined = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  combined += chunk;
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  combined += chunk;
});

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

child.on('close', (code) => {
  const files = parseSummaryLine(combined, 'Test Files');
  const tests = parseSummaryLine(combined, 'Tests');

  const problems = [];
  if (!files) {
    problems.push('could not find a "Test Files" summary line at all.');
  } else if (files.failed + files.passed + files.skipped + files.todo !== files.total) {
    problems.push(
      `files: ${files.failed} failed + ${files.passed} passed + ${files.skipped} skipped + ${files.todo} todo ` +
        `= ${files.failed + files.passed + files.skipped + files.todo}, but collected ${files.total}.`,
    );
  }
  if (!tests) {
    problems.push('could not find a "Tests" summary line at all.');
  } else if (tests.failed + tests.passed + tests.skipped + tests.todo !== tests.total) {
    problems.push(
      `tests: ${tests.failed} failed + ${tests.passed} passed + ${tests.skipped} skipped + ${tests.todo} todo ` +
        `= ${tests.failed + tests.passed + tests.skipped + tests.todo}, but collected ${tests.total}.`,
    );
  }

  if (problems.length > 0) {
    console.error('\nSUITE INCOMPLETE — do not trust this run:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('  A worker likely crashed mid-run and silently dropped a whole file (#184).');
    process.exit(1);
  }

  process.exit(code ?? 1);
});
