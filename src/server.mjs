import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFixSession,
  createFeatureFlagRemovalSession,
  createTriageSession,
  getDevinConfigStatus,
  getMode,
  getSession
} from "./lib/devin-client.mjs";
import { createEvent, mutateState, readState } from "./lib/store.mjs";
import { mockTriage, rankIssues } from "./lib/issue-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const issuesPath = path.join(rootDir, "data", "sample-issues.json");
const flagsPath = path.join(rootDir, "data", "feature-flags.json");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const CODEQL_PROOF_CACHE_MS = 20000;
const codeqlProofCache = {
  value: null,
  expiresAt: 0,
  pending: null
};
const githubIssueLinkCache = {
  value: null,
  expiresAt: 0,
  pending: null
};

function normalizeRepoSlug(value) {
  if (!value) return null;
  const trimmed = value.trim().replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
  if (!trimmed.includes("/")) return null;
  return trimmed;
}

function toOwnerRepo(value) {
  if (!value) return null;
  const cleaned = value
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  const [owner, repo] = cleaned.split("/");
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

function getCodeqlRepo() {
  const explicit = toOwnerRepo(process.env.CODEQL_TARGET_REPO || "");
  if (explicit) return explicit;
  const configuredRepos = (process.env.DEVIN_REPOS || "")
    .split(",")
    .map((value) => toOwnerRepo(value))
    .filter(Boolean);
  return configuredRepos[0] || null;
}

function getCodeqlWorkflowName() {
  return process.env.CODEQL_WORKFLOW_NAME?.trim() || "CodeQL Devin Fix Batches";
}

function getCodeqlUrls(repo) {
  if (!repo) {
    return {
      actionsUrl: null,
      workflowUrl: null,
      workflowRunsUrl: null
    };
  }
  const actionsUrl = `https://github.com/${repo}/actions`;
  const workflowUrl = `https://github.com/${repo}/actions/workflows/codeql-devin-fixes.yml`;
  return {
    actionsUrl,
    workflowUrl,
    workflowRunsUrl: `${workflowUrl}?query=event%3Aworkflow_dispatch`
  };
}

function buildSeedIssueBody(issue) {
  const labels = Array.isArray(issue.labels) ? issue.labels.join(", ") : "";
  return [
    "Seeded demo issue from Issue Avalanche.",
    "",
    `Issue id: #${issue.id} (matches dashboard issue id)`,
    `Area: ${issue.area || "unknown"}`,
    `Type: ${issue.type || "unknown"}`,
    labels ? `Labels: ${labels}` : null,
    "",
    "Summary:",
    issue.summary || ""
  ]
    .filter(Boolean)
    .join("\n");
}

function buildNewIssueUrl(repo, issue) {
  if (!repo) return issue.source?.url || null;
  const params = new URLSearchParams({
    title: issue.title || `Issue ${issue.id}`,
    body: buildSeedIssueBody(issue)
  });
  if (Array.isArray(issue.labels) && issue.labels.length) {
    params.set("labels", issue.labels.join(","));
  }
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

async function inferCodeqlRepoFromSeededIssues() {
  try {
    const issues = await readIssues();
    for (const issue of issues) {
      const sourceUrl = issue?.source?.url;
      const parsed = toOwnerRepo(sourceUrl || "");
      if (parsed) return parsed;
    }
  } catch {
    // Best-effort inference only.
  }
  return null;
}

async function githubRequest(pathname) {
  const token = process.env.GITHUB_TOKEN?.trim();
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "issue-avalanche-dashboard"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`github_http_${response.status}:${text.slice(0, 180)}`);
  }
  return response.json();
}

function summarizeCodeqlRun(run) {
  if (!run) return "No workflow runs yet.";
  if (run.status !== "completed") return "Workflow run is in progress.";
  if (run.conclusion === "success") return "Workflow completed successfully.";
  if (run.conclusion) return `Workflow completed with ${run.conclusion}.`;
  return "Workflow run completed.";
}

async function fetchCodeqlProof() {
  const configuredRepo = getCodeqlRepo();
  const inferredRepo = configuredRepo ? null : await inferCodeqlRepoFromSeededIssues();
  const repo = configuredRepo || inferredRepo;
  const repoSource = configuredRepo ? "env" : inferredRepo ? "seeded_issues" : "none";
  const workflowName = getCodeqlWorkflowName();
  const links = getCodeqlUrls(repo);
  if (!repo) {
    return {
      status: "not_configured",
      workflowName,
      repo: null,
      repoSource,
      hasGithubToken: Boolean(process.env.GITHUB_TOKEN?.trim()),
      ...links,
      summary:
        "CodeQL proof unavailable: set CODEQL_TARGET_REPO or DEVIN_REPOS. You can still open GitHub Actions from the repo once configured."
    };
  }

  try {
    const workflowsPayload = await githubRequest(`/repos/${repo}/actions/workflows?per_page=100`);
    const workflows = workflowsPayload.workflows || [];
    const workflow =
      workflows.find((item) => item.name === workflowName) ||
      workflows.find((item) => item.path?.endsWith("/codeql-devin-fixes.yml"));

    if (!workflow) {
      return {
        status: "workflow_not_found",
        repo,
        repoSource,
        hasGithubToken: Boolean(process.env.GITHUB_TOKEN?.trim()),
        workflowName,
        ...links,
        summary: `Workflow "${workflowName}" was not found on the default branch.`
      };
    }

    const runsPayload = await githubRequest(
      `/repos/${repo}/actions/workflows/${workflow.id}/runs?per_page=1`
    );
    const run = runsPayload.workflow_runs?.[0] || null;
    const startedAt = run?.run_started_at ? Date.parse(run.run_started_at) : NaN;
    const updatedAt = run?.updated_at ? Date.parse(run.updated_at) : NaN;
    const durationMs = Number.isFinite(startedAt) && Number.isFinite(updatedAt) ? Math.max(updatedAt - startedAt, 0) : null;

    return {
      status: run ? "ok" : "no_runs",
      repo,
      repoSource,
      hasGithubToken: Boolean(process.env.GITHUB_TOKEN?.trim()),
      workflowName,
      actionsUrl: links.actionsUrl,
      workflowUrl: links.workflowUrl,
      workflowFileUrl: workflow.html_url || null,
      workflowRunsUrl: links.workflowRunsUrl,
      summary: summarizeCodeqlRun(run),
      latestRun: run
        ? {
            id: run.id,
            runNumber: run.run_number,
            status: run.status,
            conclusion: run.conclusion,
            branch: run.head_branch,
            event: run.event,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
            durationMs,
            url: run.html_url
          }
        : null
    };
  } catch (error) {
    return {
      status: "error",
      repo,
      repoSource,
      hasGithubToken: Boolean(process.env.GITHUB_TOKEN?.trim()),
      workflowName,
      ...links,
      summary: "Unable to fetch workflow proof from GitHub.",
      error: error.message
    };
  }
}

async function getCodeqlProof() {
  const now = Date.now();
  if (codeqlProofCache.value && codeqlProofCache.expiresAt > now) {
    return codeqlProofCache.value;
  }
  if (codeqlProofCache.pending) {
    return codeqlProofCache.pending;
  }
  codeqlProofCache.pending = fetchCodeqlProof()
    .then((value) => {
      codeqlProofCache.value = value;
      codeqlProofCache.expiresAt = Date.now() + CODEQL_PROOF_CACHE_MS;
      return value;
    })
    .finally(() => {
      codeqlProofCache.pending = null;
    });
  return codeqlProofCache.pending;
}

function preferredGithubIssue(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.state !== b.state) {
    return a.state === "open" ? a : b;
  }
  const aUpdated = Date.parse(a.updated_at || a.created_at || 0);
  const bUpdated = Date.parse(b.updated_at || b.created_at || 0);
  return bUpdated > aUpdated ? b : a;
}

async function fetchGithubIssueLinkData(issues) {
  const configuredRepo = getCodeqlRepo();
  const inferredRepo = configuredRepo ? null : await inferCodeqlRepoFromSeededIssues();
  const repo = configuredRepo || inferredRepo;
  if (!repo) {
    return { repo: null, map: {} };
  }

  try {
    const payload = await githubRequest(`/repos/${repo}/issues?state=all&per_page=100`);
    const githubIssues = Array.isArray(payload) ? payload.filter((item) => !item.pull_request) : [];
    const byTitle = new Map();

    for (const issue of githubIssues) {
      const key = String(issue.title || "").trim().toLowerCase();
      if (!key) continue;
      const current = byTitle.get(key);
      byTitle.set(key, preferredGithubIssue(current, issue));
    }

    const map = {};
    for (const issue of issues) {
      const key = String(issue.title || "").trim().toLowerCase();
      const match = byTitle.get(key);
      if (!match?.html_url) continue;
      map[String(issue.id)] = {
        number: match.number,
        url: match.html_url,
        state: match.state
      };
    }

    return { repo, map };
  } catch {
    return { repo, map: {} };
  }
}

async function getGithubIssueLinkData(issues) {
  const now = Date.now();
  if (githubIssueLinkCache.value && githubIssueLinkCache.expiresAt > now) {
    return githubIssueLinkCache.value;
  }
  if (githubIssueLinkCache.pending) {
    return githubIssueLinkCache.pending;
  }
  githubIssueLinkCache.pending = fetchGithubIssueLinkData(issues)
    .then((value) => {
      githubIssueLinkCache.value = value;
      githubIssueLinkCache.expiresAt = Date.now() + 30000;
      return value;
    })
    .finally(() => {
      githubIssueLinkCache.pending = null;
    });
  return githubIssueLinkCache.pending;
}

function getIntegrations() {
  const liveMode = getMode() === "live";
  const assumeConnectedInLive = process.env.DEMO_ASSUME_CONNECTED_INTEGRATIONS !== "false";
  const repo = (process.env.DEVIN_REPOS || "")
    .split(",")
    .map((value) => normalizeRepoSlug(value))
    .find(Boolean);
  const githubUrl = repo ? `https://github.com/${repo}` : null;
  const linearUrl = process.env.LINEAR_WORKSPACE_URL?.trim() || null;
  const slackUrl = process.env.SLACK_CHANNEL_URL?.trim() || null;
  const linearConnected = Boolean(linearUrl) || (liveMode && assumeConnectedInLive);
  const slackConnected = Boolean(slackUrl) || (liveMode && assumeConnectedInLive);

  return [
    {
      id: "github",
      label: "GitHub",
      connected: Boolean(githubUrl),
      url: githubUrl,
      detail: repo || "Not configured"
    },
    {
      id: "linear",
      label: "Linear",
      connected: linearConnected,
      url: linearUrl,
      detail: linearUrl ? "Workspace connected" : linearConnected ? "Connected in Devin account" : "Not configured"
    },
    {
      id: "slack",
      label: "Slack",
      connected: slackConnected,
      url: slackUrl,
      detail: slackUrl ? "Channel connected" : slackConnected ? "Connected in Devin account" : "Not configured"
    }
  ];
}

function getSlackContext() {
  const channel = process.env.SLACK_CHANNEL_NAME?.trim() || "#eng-automation";
  const reviewers = (process.env.SLACK_REVIEWER_HANDLES || "@integrations-oncall,@sre-reviewers")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
  return { channel, reviewers };
}

async function postSlackMessage(text) {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  const channelId = process.env.SLACK_CHANNEL_ID?.trim();
  if (!token || !channelId) {
    return { delivered: false, reason: "missing_credentials" };
  }

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        channel: channelId,
        text
      })
    });

    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      return { delivered: false, reason: payload.error || `http_${response.status}` };
    }

    return { delivered: true };
  } catch {
    return { delivered: false, reason: "network_error" };
  }
}

async function linearRequest(query, variables = {}) {
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) throw new Error("missing_linear_api_key");

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey
    },
    body: JSON.stringify({ query, variables })
  });

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors[0].message || `linear_http_${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`linear_http_${response.status}`);
  }
  return payload.data;
}

async function ensureLinearIssue(state, issue) {
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  const teamKey = process.env.LINEAR_TEAM_KEY?.trim();
  if (!apiKey || !teamKey) return null;

  state.linearIssueMap ||= {};
  const existing = state.linearIssueMap[String(issue.id)];
  if (existing?.id) return existing;

  const teamsData = await linearRequest(`
    query Teams {
      teams {
        nodes {
          id
          key
        }
      }
    }
  `);

  const teamId = teamsData?.teams?.nodes?.find((team) => team.key === teamKey)?.id;
  if (!teamId) return null;

  const sourceUrl = issue.source?.url || "";
  const createData = await linearRequest(
    `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
    `,
    {
      input: {
        teamId,
        title: `[GitHub #${issue.id}] ${issue.title}`,
        description: `Auto-synced from Issue Avalanche.\n\nGitHub source: ${sourceUrl}\n\nSummary:\n${issue.summary}`
      }
    }
  );

  const created = createData?.issueCreate?.issue;
  if (!createData?.issueCreate?.success || !created?.id) return null;

  state.linearIssueMap[String(issue.id)] = {
    id: created.id,
    identifier: created.identifier || null,
    url: created.url || null,
    teamId
  };
  return state.linearIssueMap[String(issue.id)];
}

async function getLinearStateId(state, teamId, stateName) {
  if (!teamId || !stateName) return null;
  state.linearStateMap ||= {};
  state.linearStateMap[teamId] ||= {};

  const cached = state.linearStateMap[teamId][stateName];
  if (cached) return cached;

  const teamData = await linearRequest(
    `
      query TeamStates($id: String!) {
        team(id: $id) {
          states {
            nodes {
              id
              name
            }
          }
        }
      }
    `,
    { id: teamId }
  );

  const states = teamData?.team?.states?.nodes || [];
  const match = states.find((node) => node.name?.toLowerCase() === stateName.toLowerCase());
  if (!match?.id) return null;

  state.linearStateMap[teamId][stateName] = match.id;
  return match.id;
}

async function updateLinearIssueState(issueId, stateId) {
  if (!issueId || !stateId) return false;
  const updateData = await linearRequest(
    `
      mutation UpdateIssueState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }
    `,
    { id: issueId, stateId }
  );

  return Boolean(updateData?.issueUpdate?.success);
}

async function postLinearUpdate(state, issue, body, targetStateName = null) {
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  const teamKey = process.env.LINEAR_TEAM_KEY?.trim();
  if (!apiKey || !teamKey) {
    return { delivered: false, reason: "missing_credentials" };
  }

  try {
    const linearIssue = await ensureLinearIssue(state, issue);
    if (!linearIssue?.id) return { delivered: false, reason: "issue_resolution_failed" };
    let stateTransitioned = false;
    let stateTransitionReason = null;

    if (targetStateName) {
      const stateId = await getLinearStateId(state, linearIssue.teamId, targetStateName);
      if (stateId) {
        const success = await updateLinearIssueState(linearIssue.id, stateId);
        stateTransitioned = success;
        if (!success) {
          stateTransitionReason = `state_update_failed:${targetStateName}`;
        }
      } else {
        stateTransitionReason = `state_not_found:${targetStateName}`;
      }
    }

    const commentData = await linearRequest(
      `
        mutation CreateComment($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
          }
        }
      `,
      {
        input: {
          issueId: linearIssue.id,
          body
        }
      }
    );

    if (!commentData?.commentCreate?.success) {
      return {
        delivered: false,
        reason: "comment_create_failed",
        identifier: linearIssue.identifier,
        stateTransitioned,
        stateTransitionReason
      };
    }

    return {
      delivered: true,
      identifier: linearIssue.identifier,
      stateTransitioned,
      stateTransitionReason
    };
  } catch (error) {
    return { delivered: false, reason: error.message };
  }
}

async function pushLinearEvent(state, issue, detail, targetStateName = null) {
  const result = await postLinearUpdate(state, issue, detail, targetStateName);
  const stateNote = targetStateName
    ? result.stateTransitioned
      ? ` [state -> ${targetStateName}]`
      : result.stateTransitionReason
        ? ` [state pending: ${result.stateTransitionReason}]`
        : ""
    : "";
  const summary = result.delivered
    ? `Linear delivered: ${detail}${result.identifier ? ` (${result.identifier})` : ""}${stateNote}`
    : `Linear simulated: ${detail}${result.reason ? ` (${result.reason})` : ""}`;
  state.events.unshift(createEvent("linear_sync", issue.id, summary));
}

async function pushSlackEvent(state, issueId, detail) {
  const result = await postSlackMessage(detail);
  const summary = result.delivered
    ? `Slack delivered: ${detail}`
    : `Slack simulated: ${detail}${result.reason ? ` (${result.reason})` : ""}`;
  state.events.unshift(createEvent("slack_message", issueId, summary));
}

async function readIssues() {
  const raw = await fs.readFile(issuesPath, "utf8");
  return JSON.parse(raw);
}

async function readFlags() {
  const raw = await fs.readFile(flagsPath, "utf8");
  return JSON.parse(raw);
}

function normalizeSessionStatus(latest, { triageHasStructuredOutput = false } = {}) {
  const rawStatus = String(latest.status || "").toLowerCase();
  const rawEnum = String(latest.status_enum || "").toLowerCase();
  const rawDetail = String(latest.status_detail || "").toLowerCase();

  if (
    rawStatus === "completed" ||
    rawStatus === "exit" ||
    rawEnum === "finished" ||
    rawDetail === "finished" ||
    triageHasStructuredOutput
  ) {
    return "completed";
  }

  if (rawStatus === "error" || rawStatus === "failed" || rawEnum === "failed" || rawDetail === "failed") {
    return "error";
  }

  if (
    rawStatus === "paused" ||
    rawEnum === "paused" ||
    rawDetail === "paused" ||
    rawDetail.includes("awaiting") ||
    rawDetail.includes("waiting")
  ) {
    return "paused";
  }

  return "running";
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function getDashboardState() {
  const [issues, flags, state, codeql] = await Promise.all([
    readIssues(),
    readFlags(),
    readState(),
    getCodeqlProof()
  ]);
  const githubIssueLinkData = await getGithubIssueLinkData(issues);
  const resolvedIssueLinks = githubIssueLinkData.map || {};
  const flagRuns = state.flagRuns || {};
  return {
    mode: getMode(),
    integrations: getIntegrations(),
    codeql,
    issues: rankIssues(issues, state.automationRuns).map((issue) => {
      const resolved = resolvedIssueLinks[String(issue.id)];
      const repo = githubIssueLinkData.repo;
      const createIssueUrl = buildNewIssueUrl(repo, issue);
      const searchOpenUrl = repo
        ? `https://github.com/${repo}/issues?q=${encodeURIComponent(`is:issue is:open ${issue.title}`)}`
        : issue.source?.url || null;
      if (!resolved) {
        return {
          ...issue,
          source: {
            ...(issue.source || {}),
            system: "github",
            url: createIssueUrl
          },
          githubIssueState: "missing"
        };
      }
      const fallbackOpenSearchUrl = resolved.state === "closed" ? createIssueUrl || searchOpenUrl : resolved.url;
      return {
        ...issue,
        githubIssueNumber: resolved.number || issue.githubIssueNumber,
        githubIssueState: resolved.state || null,
        source: {
          ...(issue.source || {}),
          system: "github",
          url: fallbackOpenSearchUrl
        }
      };
    }),
    flags: flags.map((flag) => ({
      ...flag,
      automation: flagRuns[flag.key] || {}
    })),
    events: state.events.slice(0, 20)
  };
}

async function syncRuns() {
  const [issues, flags] = await Promise.all([readIssues(), readFlags()]);
  const issueMap = new Map(issues.map((issue) => [String(issue.id), issue]));
  const flagMap = new Map(flags.map((flag) => [String(flag.key), flag]));

  const nextState = await mutateState(async (state) => {
    const entries = Object.entries(state.automationRuns);
    state.flagRuns ||= {};
    for (const flagKey of Object.keys(state.flagRuns)) {
      if (!flagMap.has(flagKey)) {
        delete state.flagRuns[flagKey];
      }
    }
    const flagEntries = Object.entries(state.flagRuns);

    for (const [issueId, run] of entries) {
      if (!run.sessionId || run.status === "completed" || run.status === "error") continue;
      let latest;
      try {
        latest = await getSession(run.sessionId, run);
      } catch (error) {
        run.lastCheckedAt = new Date().toISOString();
        run.lastError = error.message;
        continue;
      }
      const triageHasStructuredOutput = run.kind === "triage" && Boolean(latest.structured_output);
      const normalizedStatus = normalizeSessionStatus(latest, { triageHasStructuredOutput });

      run.status = normalizedStatus;
      run.lastCheckedAt = new Date().toISOString();
      if (run.lastError) {
        delete run.lastError;
      }

      if (run.kind === "triage" && latest.structured_output) {
        run.triage = latest.structured_output;
      }

      if (run.kind === "fix" && latest.pull_request?.url) {
        run.pullRequestUrl = latest.pull_request.url;
      }

      if (run.kind === "fix" && Array.isArray(latest.pull_requests) && latest.pull_requests[0]?.pr_url) {
        run.pullRequestUrl = latest.pull_requests[0].pr_url;
      }

      if (normalizedStatus === "completed" && !run.completedEventEmitted) {
        const issue = issueMap.get(issueId);
        const message =
          run.kind === "triage"
            ? `Triage completed for #${issueId}. Recommended action: ${run.triage?.recommended_action || "review"}.`
            : `Fix session completed for #${issueId}${run.pullRequestUrl ? ` and opened ${run.pullRequestUrl}.` : "."}`;
        state.events.unshift(createEvent("completed", Number(issueId), message));
        const integrations = getIntegrations();
        if (integrations.find((item) => item.id === "linear")?.connected) {
          const linearStatus = run.kind === "triage" ? "Triaged" : "In Review";
          if (issue) {
            await pushLinearEvent(
              state,
              issue,
              `Linear synced issue #${issueId} -> ${linearStatus}.`,
              run.kind === "fix" ? process.env.LINEAR_IN_REVIEW_STATE_NAME?.trim() || "In Review" : null
            );
          }
        }
        if (integrations.find((item) => item.id === "slack")?.connected) {
          const slack = getSlackContext();
          const slackCopy =
            run.kind === "triage"
              ? `Slack ${slack.channel}: triage completed for #${issueId} (${run.triage?.recommended_action || "review"}). ${slack.reviewers} please approve next step.`
              : `Slack ${slack.channel}: Devin fix completed for #${issueId}${run.pullRequestUrl ? `, PR ready ${run.pullRequestUrl}.` : "."} ${slack.reviewers} please review.`;
          await pushSlackEvent(state, Number(issueId), slackCopy);
        }
        run.completedEventEmitted = true;
        if (issue && run.kind === "fix") {
          run.handoffNote = `PR ready for reviewer in ${issue.area}.`;
        }
      }

      if (normalizedStatus === "paused" && !run.pausedEventEmitted) {
        state.events.unshift(
          createEvent(
            "attention_needed",
            Number(issueId),
            `Issue #${issueId} session is paused and awaiting instructions in Devin.`
          )
        );
        run.pausedEventEmitted = true;
      }
    }

    for (const [flagKey, run] of flagEntries) {
      if (!run.sessionId || run.status === "completed" || run.status === "error") continue;
      let latest;
      try {
        latest = await getSession(run.sessionId, run);
      } catch (error) {
        run.lastCheckedAt = new Date().toISOString();
        run.lastError = error.message;
        continue;
      }

      const normalizedStatus = normalizeSessionStatus(latest);

      run.status = normalizedStatus;
      run.lastCheckedAt = new Date().toISOString();
      if (run.lastError) delete run.lastError;

      if (latest.pull_request?.url) {
        run.pullRequestUrl = latest.pull_request.url;
      }
      if (Array.isArray(latest.pull_requests) && latest.pull_requests[0]?.pr_url) {
        run.pullRequestUrl = latest.pull_requests[0].pr_url;
      }

      if (normalizedStatus === "completed" && !run.completedEventEmitted) {
        const flag = flagMap.get(flagKey);
        state.events.unshift(
          createEvent(
            "completed",
            0,
            `Feature flag removal completed for ${flagKey}${run.pullRequestUrl ? ` and opened ${run.pullRequestUrl}.` : "."}`
          )
        );
        if (flag && getIntegrations().find((item) => item.id === "linear")?.connected) {
          await pushLinearEvent(
            state,
            {
              id: `flag-${flag.key}`,
              title: `Remove feature flag ${flag.key}`,
              summary: flag.description,
              source: { url: null }
            },
            `Linear synced feature-flag removal ${flag.key} -> In Review.`,
            process.env.LINEAR_IN_REVIEW_STATE_NAME?.trim() || "In Review"
          );
        }
        if (getIntegrations().find((item) => item.id === "slack")?.connected) {
          const slack = getSlackContext();
          await pushSlackEvent(
            state,
            0,
            `Slack ${slack.channel}: feature-flag removal completed for ${flagKey}${run.pullRequestUrl ? `, PR ready ${run.pullRequestUrl}.` : "."} ${slack.reviewers} please review.`
          );
        }
        run.completedEventEmitted = true;
      }

      if (normalizedStatus === "paused" && !run.pausedEventEmitted) {
        state.events.unshift(
          createEvent(
            "attention_needed",
            0,
            `Feature-flag session for ${flagKey} is paused and awaiting instructions in Devin.`
          )
        );
        run.pausedEventEmitted = true;
      }
    }

    state.events = state.events.slice(0, 40);
    return state;
  });

  return nextState;
}

async function createTriage(issueId) {
  const issues = await readIssues();
  const issue = issues.find((item) => String(item.id) === String(issueId));
  if (!issue) return { status: 404, payload: { error: "Issue not found" } };

  const session = await createTriageSession(issue);
  const mode = getMode();

  await mutateState(async (state) => {
    const integrations = getIntegrations();
    state.automationRuns[String(issue.id)] = {
      issueId: issue.id,
      kind: "triage",
      sessionId: session.session_id,
      status: "running",
      createdAt: new Date().toISOString(),
      triage: mode === "mock" ? session.structured_output || mockTriage(issue) : session.structured_output || null,
      sessionUrl: session.url || null
    };
    state.events.unshift(
      createEvent("triage_started", issue.id, `Started triage for #${issue.id} using Devin ${mode} mode.`)
    );
    if (integrations.find((item) => item.id === "linear")?.connected) {
      await pushLinearEvent(state, issue, `Linear synced issue #${issue.id} -> Triage In Progress.`);
    }
    if (integrations.find((item) => item.id === "slack")?.connected) {
      const slack = getSlackContext();
      await pushSlackEvent(
        state,
        issue.id,
        `Slack ${slack.channel}: starting triage for #${issue.id}. I will post recommendation + confidence when complete.`
      );
    }
    state.events = state.events.slice(0, 40);
    return state;
  });

  return { status: 200, payload: { ok: true } };
}

async function createFix(issueId) {
  const issues = await readIssues();
  const issue = issues.find((item) => String(item.id) === String(issueId));
  if (!issue) return { status: 404, payload: { error: "Issue not found" } };

  const state = await readState();
  const existing = state.automationRuns[String(issue.id)];
  const triage = existing?.triage || mockTriage(issue);
  const session = await createFixSession(issue, triage);

  await mutateState(async (nextState) => {
    const integrations = getIntegrations();
    nextState.automationRuns[String(issue.id)] = {
      issueId: issue.id,
      kind: "fix",
      sessionId: session.session_id,
      status: "running",
      createdAt: new Date().toISOString(),
      triage,
      sessionUrl: session.url || null,
      pullRequestUrl: session.pull_request?.url || null
    };
    nextState.events.unshift(
      createEvent("fix_started", issue.id, `Started autonomous fix session for #${issue.id}.`)
    );
    if (integrations.find((item) => item.id === "linear")?.connected) {
      await pushLinearEvent(
        nextState,
        issue,
        `Linear synced issue #${issue.id} -> In Progress.`,
        process.env.LINEAR_IN_PROGRESS_STATE_NAME?.trim() || "In Progress"
      );
    }
    if (integrations.find((item) => item.id === "slack")?.connected) {
      const slack = getSlackContext();
      await pushSlackEvent(
        nextState,
        issue.id,
        `Slack ${slack.channel}: launched Devin fix for #${issue.id}. Tracking session ${session.url || "(session link unavailable)"}`
      );
    }
    nextState.events = nextState.events.slice(0, 40);
    return nextState;
  });

  return { status: 200, payload: { ok: true } };
}

async function createFeatureFlagRemoval(flagKey) {
  const flags = await readFlags();
  const flag = flags.find((item) => String(item.key) === String(flagKey));
  if (!flag) return { status: 404, payload: { error: "Feature flag not found" } };

  const session = await createFeatureFlagRemovalSession(flag);

  await mutateState(async (state) => {
    const integrations = getIntegrations();
    state.flagRuns ||= {};
    state.flagRuns[String(flag.key)] = {
      flagKey: flag.key,
      kind: "feature_flag_removal",
      sessionId: session.session_id,
      status: "running",
      createdAt: new Date().toISOString(),
      sessionUrl: session.url || null,
      pullRequestUrl: session.pull_request?.url || null
    };
    state.events.unshift(
      createEvent("flag_removal_started", 0, `Started feature-flag removal session for ${flag.key}.`)
    );

    if (integrations.find((item) => item.id === "linear")?.connected) {
      await pushLinearEvent(
        state,
        {
          id: `flag-${flag.key}`,
          title: `Remove feature flag ${flag.key}`,
          summary: flag.description,
          source: { url: null }
        },
        `Linear synced feature-flag removal ${flag.key} -> In Progress.`,
        process.env.LINEAR_IN_PROGRESS_STATE_NAME?.trim() || "In Progress"
      );
    }
    if (integrations.find((item) => item.id === "slack")?.connected) {
      const slack = getSlackContext();
      await pushSlackEvent(
        state,
        0,
        `Slack ${slack.channel}: launched feature-flag removal for ${flag.key}. Tracking session ${session.url || "(session link unavailable)"}`
      );
    }

    state.events = state.events.slice(0, 40);
    return state;
  });

  return { status: 200, payload: { ok: true } };
}

async function resetDemoState() {
  await mutateState(() => ({
    automationRuns: {},
    flagRuns: {},
    events: [],
    linearIssueMap: {},
    linearStateMap: {}
  }));
  return { status: 200, payload: { ok: true } };
}

async function serveStatic(req, res) {
  const reqPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(publicDir, reqPath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "application/javascript; charset=utf-8"
            : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/dashboard") {
      await syncRuns();
      json(res, 200, await getDashboardState());
      return;
    }

    if (req.method === "GET" && req.url === "/api/devin/config") {
      json(res, 200, getDevinConfigStatus());
      return;
    }

    if (req.method === "POST" && req.url === "/api/sync") {
      await syncRuns();
      json(res, 200, await getDashboardState());
      return;
    }

    if (req.method === "POST" && req.url === "/api/reset") {
      const result = await resetDemoState();
      json(res, result.status, result.payload);
      return;
    }

    const triageMatch = req.method === "POST" && req.url.match(/^\/api\/issues\/(\d+)\/triage$/);
    if (triageMatch) {
      await parseBody(req);
      const result = await createTriage(triageMatch[1]);
      json(res, result.status, result.payload);
      return;
    }

    const fixMatch = req.method === "POST" && req.url.match(/^\/api\/issues\/(\d+)\/fix$/);
    if (fixMatch) {
      await parseBody(req);
      const result = await createFix(fixMatch[1]);
      json(res, result.status, result.payload);
      return;
    }

    const flagMatch = req.method === "POST" && req.url.match(/^\/api\/flags\/([^/]+)\/remove$/);
    if (flagMatch) {
      await parseBody(req);
      const flagKey = decodeURIComponent(flagMatch[1]);
      const result = await createFeatureFlagRemoval(flagKey);
      json(res, result.status, result.payload);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Issue Avalanche running at http://${host}:${port}`);
});
