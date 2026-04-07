import test from "node:test";
import assert from "node:assert/strict";
import { buildFixPrompt, buildTriagePrompt, mockTriage, rankIssues, scoreIssue } from "../src/lib/issue-engine.mjs";
import issues from "../data/sample-issues.json" with { type: "json" };

test("scoreIssue favors severe, stale issues", () => {
  const high = scoreIssue(issues[0], new Date("2026-04-01T00:00:00Z"));
  const critical = scoreIssue(issues[2], new Date("2026-04-01T00:00:00Z"));
  assert.ok(critical.total > high.total);
});

test("rankIssues sorts descending by score", () => {
  const ranked = rankIssues(issues, {}, new Date("2026-04-01T00:00:00Z"));
  assert.equal(ranked[0].id, 3);
});

test("triage and fix prompts contain issue context", () => {
  const triagePrompt = buildTriagePrompt(issues[0]);
  assert.match(triagePrompt, /Issue #1/);
  const triage = mockTriage(issues[0]);
  const fixPrompt = buildFixPrompt(issues[0], triage);
  assert.match(fixPrompt, /Target issue: #1/);
  assert.match(fixPrompt, /Suggested validation/);
});
