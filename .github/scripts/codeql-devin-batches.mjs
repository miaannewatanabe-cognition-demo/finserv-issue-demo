#!/usr/bin/env node

const githubToken = process.env.GITHUB_TOKEN;
const targetRepo = process.env.TARGET_REPO || process.env.GITHUB_REPOSITORY;
const batchSize = Number(process.env.BATCH_SIZE || "10");
const maxBatches = Number(process.env.MAX_BATCHES || "3");
const severities = (process.env.SEVERITIES || "critical,high,medium")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const devinApiKey = process.env.DEVIN_API_KEY;
const devinOrgId = process.env.DEVIN_ORG_ID;
const devinApiBase = process.env.DEVIN_API_BASE_URL || "https://api.devin.ai";
const devinRepos = process.env.DEVIN_REPOS || `github.com/${targetRepo}`;
const createAsUserId = process.env.DEVIN_CREATE_AS_USER_ID || "";

if (!githubToken) throw new Error("Missing GITHUB_TOKEN");
if (!targetRepo) throw new Error("Missing TARGET_REPO or GITHUB_REPOSITORY");
if (!devinApiKey) throw new Error("Missing DEVIN_API_KEY secret");
if (!devinOrgId) throw new Error("Missing DEVIN_ORG_ID secret");

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function githubFetch(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": "issue-avalanche-codeql-action"
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }
  return response.json();
}

async function getOpenCodeQlAlerts(repo) {
  const alerts = [];
  let page = 1;
  while (true) {
    const pageAlerts = await githubFetch(
      `/repos/${repo}/code-scanning/alerts?state=open&tool_name=CodeQL&per_page=100&page=${page}`
    );
    if (!Array.isArray(pageAlerts) || !pageAlerts.length) break;
    alerts.push(...pageAlerts);
    if (pageAlerts.length < 100) break;
    page += 1;
  }
  return alerts;
}

function toAlertSummary(alert) {
  return {
    number: alert.number,
    rule: alert.rule?.id || "unknown-rule",
    severity: (alert.rule?.security_severity_level || alert.rule?.severity || "unknown").toLowerCase(),
    state: alert.state,
    location: `${alert.most_recent_instance?.location?.path || "unknown"}:${alert.most_recent_instance?.location?.start_line || "?"}`,
    html_url: alert.html_url
  };
}

function buildCodeQlPrompt(repo, batchIndex, totalBatches, alerts) {
  const lines = alerts
    .map(
      (alert) =>
        `- Alert #${alert.number} | ${alert.rule} | severity=${alert.severity} | location=${alert.location} | ${alert.html_url}`
    )
    .join("\n");

  return `
You are Devin fixing CodeQL security alerts in a GitHub repository.

Repository: ${repo}
Batch: ${batchIndex + 1} of ${totalBatches}
Alert count in this batch: ${alerts.length}

Target alerts:
${lines}

Execution instructions:
1. Check out repository ${repo} and inspect each alert location and sink/source path.
2. Apply safe, minimal fixes for this batch only.
3. Add or update tests where practical to prevent regressions.
4. Run relevant validation commands before opening a PR.
5. Open a PR that references each alert number fixed in this batch.
6. If blocked on a specific alert, document exactly why and continue with the rest of the batch.

Output expectation:
- One PR for this batch with a concise security-oriented summary and verification notes.
  `.trim();
}

async function createDevinSessionForBatch(repo, batchIndex, totalBatches, alerts) {
  const response = await fetch(`${devinApiBase}/v3/organizations/${devinOrgId}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${devinApiKey}`
    },
    body: JSON.stringify({
      title: `CodeQL batch ${batchIndex + 1}/${totalBatches} for ${repo}`,
      prompt: buildCodeQlPrompt(repo, batchIndex, totalBatches, alerts),
      tags: ["codeql-fix", "batch", `batch-${batchIndex + 1}`],
      repos: [devinRepos],
      ...(createAsUserId ? { create_as_user_id: createAsUserId } : {})
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Devin API ${response.status}: ${text}`);
  }
  return response.json();
}

async function main() {
  const allAlerts = (await getOpenCodeQlAlerts(targetRepo)).map(toAlertSummary);
  const filtered = allAlerts.filter((alert) => severities.includes(alert.severity));
  if (!filtered.length) {
    console.log("No open CodeQL alerts found for selected severities.");
    return;
  }

  const batches = chunk(filtered, Math.max(1, batchSize)).slice(0, Math.max(1, maxBatches));
  const launched = [];
  for (let i = 0; i < batches.length; i += 1) {
    const session = await createDevinSessionForBatch(targetRepo, i, batches.length, batches[i]);
    launched.push({
      batch: i + 1,
      alertCount: batches[i].length,
      sessionId: session.session_id,
      sessionUrl: session.url || null
    });
  }

  console.log(JSON.stringify({ repo: targetRepo, totalAlerts: filtered.length, launched }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
