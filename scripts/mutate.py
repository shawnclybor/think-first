#!/usr/bin/env python3
"""mutate.py — prove think-first's tests can fail.

A test suite that has only ever passed is indistinguishable from one that cannot fail.
This copies the plugin to a temp dir once per mutant, breaks one behaviour on purpose,
runs `claude plugin test`, and requires the suite to go RED. The unmutated copy must
go GREEN first, or nothing below means anything.

Exit 0 = the clean copy passes AND every mutant is caught.
Exit 1 = a mutant survived (a test is missing or toothless), or the clean copy failed.
Exit 2 = a mutation did not apply (the source moved; update the mutant, don't skip it).

Usage: python3 plugins/think-first/scripts/mutate.py
"""
import os
import shutil
import subprocess
import sys
import tempfile

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
THINK = "hooks/think.ts"
REGISTER = "hooks/register.ts"

# (id, what it breaks, file, exact text to find, replacement)
MUTANTS = [
    ("T1", "writes are never blocked", THINK,
     "const writing = write && !(s.thoughtUntil > now)", "const writing = false"),
    ("T2", "retries are never blocked", THINK,
     "const retrying = write && s.failed.has(tool) && matches(retries, tool)", "const retrying = false"),
    ("T3", "a new user message does not clear degraded mode", REGISTER,
     "    s.degraded = null\n    s.unattended = UNATTENDED.has(origin)\n", "    s.unattended = UNATTENDED.has(origin)\n"),
    ("T4", "a failed call is not recorded", REGISTER,
     "if (r.isError && write) s.failed.add(e.tool)", "if (false) s.failed.add(e.tool)"),
    ("T5", "a thinking step does not clear failures", REGISTER,
     "        s.failed.clear()\n", ""),
    ("T6", "one thinking-tool error already counts as unavailable", REGISTER,
     "s.thinkErrors >= 2", "s.thinkErrors >= 1"),
    ("T7", "a malformed thinking call counts as unavailable", REGISTER,
     "} else if (r.isError && !isMalformed(r.text ?? '')) {", "} else if (r.isError) {"),
    ("T8", "a crash lets the call through", REGISTER,
     "if (!isThinkTool(e.tool) && (e.tool.startsWith('mcp__') || matches(writes, e.tool))) {", "if (false) {"),
    ("T9", "warn mode blocks like enforce", REGISTER,
     "options.mode === 'warn' ? 'warn' : 'enforce'", "'enforce'"),
    ("T10", "broken settings are silently ignored", THINK,
     "if (errors.length > 0 && tool.startsWith('mcp__')) {", "if (false) {"),
    ("T11", "any failure blocks every tool", THINK,
     "const retrying = write && s.failed.has(tool) && matches(retries, tool)", "const retrying = write && s.failed.size > 0 && matches(retries, tool)"),
    ("T12", "notes to Claude are dropped", REGISTER,
     "if (note && r.deny === undefined)", "if (false)"),
    ("T14", "nothing counts as continuing work; every prompt resets", REGISTER,
     "    if (CONTINUES.has(origin)) {\n", "    if (false) {\n"),
    ("T15", "no prompt resets except the person typing", REGISTER,
     "    if (CONTINUES.has(origin)) {\n", "    if (origin !== 'composer') {\n"),
    ("T16", "marks itself active even with broken settings", REGISTER,
     "const announce = writes.res.length > 0 && writes.errors.length === 0 && retries.errors.length === 0", "const announce = true"),
    ("T17", "never marks itself active", REGISTER,
     "const announce = writes.res.length > 0 && writes.errors.length === 0 && retries.errors.length === 0", "const announce = false"),
    ("T18", "a crashed prompt hook does not reset", REGISTER,
     "    // prompt still goes on.\n    reset('')\n", "    // prompt still goes on.\n"),
    # No mutant for the `e.origin?.kind` safe read: removing it makes a prompt with no
    # origin crash the hook, and the .catch then resets exactly as the hook would have.
    # Same observable behaviour, so no test can (or should) tell them apart; T18 covers
    # the .catch that makes that true.
    ("T13", "a successful thinking step is not recorded", REGISTER,
     "        s.thoughtUntil = now + TTL_MS\n", ""),
    ("T19", "a missing thinking tool never lets a write through", REGISTER,
     "if (names !== null && !hasThinkTool(names)) d =", "if (false) d ="),
    ("T20", "a listed but uncalled thinking tool lets a write through", REGISTER,
     "if (names !== null && !hasThinkTool(names)) d =", "if (names !== null) d ="),
    # 0.4.0
    ("T21", "the thinking step never expires", THINK,
     "const writing = write && !(s.thoughtUntil > now)", "const writing = write && s.thoughtUntil === 0"),
    ("T22", "shell tools are judged by name, not command", THINK,
     "isShellTool(tool) ? isShellWrite(args.command) : matches(writes, tool)", "matches(writes, tool)"),
    ("T23", "an unreadable command counts as a read", THINK,
     "if (typeof command !== 'string' || command.trim() === '') return true", "if (typeof command !== 'string' || command.trim() === '') return false"),
    ("T24", "redirects are not a write signal", THINK,
     "return />/.test(bare)", "return false"),
    ("T25", "scheduled runs block like attended ones", THINK,
     "s.unattended ? { kind: 'warn', reason: reason + SCHEDULED_NOTE } :", "false ? { kind: 'warn', reason: reason + SCHEDULED_NOTE } :"),
    ("T26", "a scheduled origin is not recognised", THINK,
     "export const UNATTENDED = new Set(['scheduled-trigger'])", "export const UNATTENDED = new Set<string>([])"),
    ("T27", "a block is not logged", REGISTER,
     "      await logDecision($, s, e.tool, 'deny', d.reason)\n", ""),
    ("T28", "the log is never trimmed", REGISTER,
     "log.slice(-LOG_MAX)", "log"),
    # No mutant for the write guard on recording a failure (`r.isError && write`): the same
    # guard on `retrying` makes it redundant by design, so a failed read retries freely if
    # either holds. T2/T4/T11 cover the retry path itself.
]


def run_tests(path):
    p = subprocess.run(["claude", "plugin", "test", path], capture_output=True, text=True)
    out = p.stdout + p.stderr
    fails = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("(fail)")]
    return p.returncode, out, fails


def main():
    rc, out, fails = run_tests(PLUGIN)
    if rc != 0 or fails or " pass" not in out:
        print("CLEAN COPY FAILED — fix the plugin before reading any mutant result.\n" + out)
        return 1
    print("clean copy: GREEN")

    survived = 0
    for mid, what, rel, find, repl in MUTANTS:
        with tempfile.TemporaryDirectory() as tmp:
            dst = os.path.join(tmp, "think-first")
            shutil.copytree(PLUGIN, dst, ignore=shutil.ignore_patterns(".claude-plugin/types"))
            f = os.path.join(dst, rel)
            src = open(f, encoding="utf-8").read()
            if src.count(find) != 1:
                print(f"{mid} DID NOT APPLY ({src.count(find)} matches) — {what}")
                return 2
            open(f, "w", encoding="utf-8").write(src.replace(find, repl))
            rc, out, fails = run_tests(dst)
            if rc != 0 and fails:
                print(f"{mid} caught   — {what}  ({len(fails)} test(s) went red)")
            else:
                survived += 1
                print(f"{mid} SURVIVED — {what}  (rc={rc}; no test failed)")
    print()
    if survived:
        print(f"FAIL: {survived} of {len(MUTANTS)} mutants survived")
        return 1
    print(f"PASS: all {len(MUTANTS)} mutants caught")
    return 0


if __name__ == "__main__":
    sys.exit(main())
