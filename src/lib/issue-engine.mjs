const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(isoDate, now = new Date()) {
  return Math.max(0, Math.floor((now.getTime() - new Date(isoDate).getTime()) / DAY_MS));
}

function labelSet(issue) {
  return new Set(issue.labels || []);
}

function inferSeverity(issue) {
  const labels = labelSet(issue);
  if (labels.has("severity:critical")) return 10;
  if (labels.has("severity:high")) return 8;
  if (labels.has("severity:medium")) return 5;
  return 3;
}

function inferQuickWin(issue) {
  const labels = labelSet(issue);
  if (labels.has("good-first-decomp")) return 8;
  if (issue.comments <= 3) return 7;
  if (issue.type === "cleanup") return 6;
  return 4;
}

function inferBusinessPressure(issue) {
  const labels = labelSet(issue);
  let score = 0;
  if (labels.has("customer-reported")) score += 4;
  if (labels.has("incident-followup")) score += 5;
  if (labels.has("developer-experience")) score += 2;
  if (labels.has("tech-debt")) score += 2;
  return Math.min(10, score || 3);
}

export function scoreIssue(issue, now = new Date()) {
  const staleDays = daysBetween(issue.updatedAt || issue.openedAt, now);
  const ageDays = daysBetween(issue.openedAt, now);
  const severity = inferSeverity(issue);
  const quickWin = inferQuickWin(issue);
  const businessPressure = inferBusinessPressure(issue);
  const stalePressure = Math.min(10, Math.round(staleDays / 14) + 1);
  const agePressure = Math.min(10, Math.round(ageDays / 30) + 1);
  const total =
    severity * 0.35 +
    quickWin * 0.2 +
    businessPressure * 0.25 +
    stalePressure * 0.1 +
    agePressure * 0.1;

  return {
    staleDays,
    ageDays,
    severity,
    quickWin,
    businessPressure,
    stalePressure,
    agePressure,
    total: Math.round(total * 10) / 10
  };
}

export function rankIssues(issues, automationRuns, now = new Date()) {
  return [...issues]
    .map((issue) => {
      const score = scoreIssue(issue, now);
      const run = automationRuns[String(issue.id)] || {};
      return {
        ...issue,
        score,
        automation: run
      };
    })
    .sort((a, b) => b.score.total - a.score.total);
}

export function buildTriagePrompt(issue) {
  return `
You are triaging a GitHub issue in an enterprise monorepo.

Issue #${issue.id}: ${issue.title}
Type: ${issue.type}
Area: ${issue.area}
Labels: ${(issue.labels || []).join(", ")}
Opened: ${issue.openedAt}
Last updated: ${issue.updatedAt}
Comments: ${issue.comments}

Summary:
${issue.summary}

Your job:
1. Decide whether this issue is a good candidate for autonomous Devin execution.
2. Estimate implementation scope and likely owner surface area.
3. Produce a concrete first-pass plan for fixing or completing it.
4. Call out any missing info that could block execution.

Optimize for practical execution, not generic advice.
  `.trim();
}

export function buildFixPrompt(issue, triage) {
  const missing = triage.missing_information?.length
    ? `Missing information to watch for:\n- ${triage.missing_information.join("\n- ")}`
    : "No blocking missing information identified.";
  const testPlan = triage.test_plan?.length
    ? triage.test_plan.join("\n- ")
    : "Add or update the narrowest tests that validate the fix.";

  return `
You are Devin acting on a GitHub issue in an enterprise monorepo.

Target issue: #${issue.id} - ${issue.title}
Area: ${issue.area}
Summary:
${issue.summary}

Prior triage:
- Recommended action: ${triage.recommended_action}
- Execution confidence: ${triage.execution_confidence}
- Scope: ${triage.scope}
- Rationale: ${triage.rationale}
- Proposed plan:
- ${triage.proposed_plan.join("\n- ")}

${missing}

Execution instructions:
1. Inspect the relevant code and confirm the root cause or implementation approach.
2. Make the smallest high-confidence change that resolves the issue.
3. Run the most relevant validation for the touched area.
4. Open a PR if the change is ready, and include a crisp summary plus test evidence.
5. If blocked, stop with a precise explanation of what is missing.

Suggested validation:
- ${testPlan}
  `.trim();
}

export function buildFeatureFlagRemovalPrompt(flag) {
  const pathHints = Array.isArray(flag.paths) && flag.paths.length
    ? flag.paths.map((item) => `- ${item}`).join("\n")
    : "- (none provided)";
  return `
You are Devin helping remove an obsolete feature flag from an enterprise monorepo.

Feature flag key: ${flag.key}
Area: ${flag.area}
Owner: ${flag.owner}
Created: ${flag.createdAt}
Description:
${flag.description}

Likely reference paths:
${pathHints}

Execution goals:
1. Locate all references to this flag key across code, tests, docs, and config.
2. Remove the feature flag and dead branches guarded by it.
3. Preserve the desired default behavior after cleanup.
4. Update or remove tests that depended on the old toggle.
5. Open a PR with concise summary and test evidence.

Requirements:
- Prefer smallest safe change-set.
- If direct key matches are missing, search for symbol-level references in the likely paths and adjacent files.
- If no references exist in this repo after path-guided search, create a short audit PR with findings, impacted repos/paths needed, and a concrete follow-up checklist. Do not wait for further instructions.
- Include a migration or rollout note if behavior changes could impact users.
  `.trim();
}

export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "recommended_action",
    "execution_confidence",
    "scope",
    "rationale",
    "proposed_plan",
    "missing_information",
    "test_plan"
  ],
  properties: {
    recommended_action: {
      type: "string",
      enum: ["autofix_now", "needs_human_review", "defer"]
    },
    execution_confidence: {
      type: "string",
      enum: ["high", "medium", "low"]
    },
    scope: {
      type: "string",
      enum: ["small", "medium", "large"]
    },
    rationale: {
      type: "string"
    },
    proposed_plan: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 6
    },
    missing_information: {
      type: "array",
      items: { type: "string" },
      maxItems: 5
    },
    test_plan: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 5
    }
  }
};

export function mockTriage(issue) {
  const score = scoreIssue(issue);
  const recommendedAction =
    score.quickWin >= 7 && score.severity >= 5 ? "autofix_now" : score.severity >= 8 ? "needs_human_review" : "defer";

  return {
    recommended_action: recommendedAction,
    execution_confidence: score.quickWin >= 7 ? "high" : "medium",
    scope: score.quickWin >= 7 ? "small" : "medium",
    rationale:
      recommendedAction === "autofix_now"
        ? "Issue appears narrow, well described, and suitable for an autonomous first pass."
        : recommendedAction === "needs_human_review"
          ? "Business impact is high, but code-path uncertainty suggests a human should confirm before merge."
          : "This can wait until higher-leverage work is cleared.",
    proposed_plan: [
      `Inspect the ${issue.area} code path and linked tests for issue #${issue.id}.`,
      "Confirm the minimal change required and implement it behind existing patterns.",
      "Run targeted validation and prepare a PR summary."
    ],
    missing_information:
      issue.comments < 3
        ? ["A clearer reproduction case from the requester would improve confidence."]
        : [],
    test_plan: [
      `Run targeted tests for ${issue.area}.`,
      "Add a regression test that matches the reported failure mode."
    ]
  };
}
