const issueList = document.querySelector("#issue-list");
const activityList = document.querySelector("#activity-list");
const flagList = document.querySelector("#flag-list");
const issueTemplate = document.querySelector("#issue-template");
const flagTemplate = document.querySelector("#flag-template");
const syncButton = document.querySelector("#sync-button");
const resetButton = document.querySelector("#reset-button");
const modePill = document.querySelector("#mode-pill");
const issueCount = document.querySelector("#issue-count");
const statusBanner = document.querySelector("#status-banner");
const integrationList = document.querySelector("#integration-list");
const codeqlSummary = document.querySelector("#codeql-summary");
const codeqlRepo = document.querySelector("#codeql-repo");
const codeqlStatus = document.querySelector("#codeql-status");
const codeqlBranch = document.querySelector("#codeql-branch");
const codeqlRunLink = document.querySelector("#codeql-run-link");
const codeqlWorkflowLink = document.querySelector("#codeql-workflow-link");
const codeqlActionsLink = document.querySelector("#codeql-actions-link");
const codeqlTalkTrack = document.querySelector("#codeql-talk-track");
const tabButtons = Array.from(document.querySelectorAll(".tab-button"));
const tabPanels = Array.from(document.querySelectorAll("[data-tab-panel]"));
const POLL_IDLE_MS = 15000;
const POLL_ACTIVE_MS = 4000;
let pollTimer = null;
let lastRenderKey = "";
let activeTab = "issues";

function relativeDays(days) {
  if (days <= 1) return "Updated today";
  return `Stale ${days} days`;
}

function titleCase(text) {
  return text
    .replaceAll("_", " ")
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function triageMarkup(issue) {
  const triage = issue.automation?.triage;
  if (!triage) {
    return "<strong>No triage yet</strong><p>Run structured triage to let Devin estimate scope, confidence, and next steps.</p>";
  }

  const plan = triage.proposed_plan.map((step) => `• ${step}`).join("<br>");
  return `
    <strong>${titleCase(triage.recommended_action)} · ${titleCase(triage.execution_confidence)} confidence</strong>
    <p>${triage.rationale}</p>
    <p>${plan}</p>
  `;
}

function buildIssueCard(issue) {
  const node = issueTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".issue-id").textContent = `Issue #${issue.id}`;
  node.querySelector(".issue-title").textContent = issue.title;
  node.querySelector(".issue-summary").textContent = issue.summary;
  node.querySelector(".score-chip").textContent = issue.score.total.toFixed(1);
  node.querySelector(".area-pill").textContent = issue.area;
  node.querySelector(".type-pill").textContent = issue.type;
  node.querySelector(".stale-pill").textContent = relativeDays(issue.score.staleDays);
  const sourcePill = node.querySelector(".source-pill");
  const sourceLink = node.querySelector(".issue-source-link");
  const sourceSystem = issue.source?.system ? titleCase(issue.source.system) : "Seeded";
  sourcePill.textContent = `Source: ${sourceSystem}`;
  if (issue.source?.url) {
    sourceLink.href = issue.source.url;
    const issueState = (issue.githubIssueState || "").toLowerCase();
    sourceLink.textContent =
      issueState === "closed" || issueState === "missing" ? "Create Source Issue" : "Open Source Issue";
    sourceLink.classList.add("visible");
  }
  node.querySelector(".triage-box").innerHTML = triageMarkup(issue);

  const labelRow = node.querySelector(".label-row");
  for (const label of issue.labels) {
    const span = document.createElement("span");
    span.className = "label";
    span.textContent = label;
    labelRow.append(span);
  }

  const triageButton = node.querySelector(".triage-action");
  const fixButton = node.querySelector(".fix-action");
  const link = node.querySelector(".session-link");
  const automation = issue.automation || {};

  if (automation.sessionUrl) {
    link.href = automation.sessionUrl;
    link.textContent = "Open Devin Session";
    link.classList.add("visible");
  }

  triageButton.disabled = automation.kind === "triage" && automation.status === "running";
  fixButton.disabled = !automation.triage || automation.status === "running";

  triageButton.addEventListener("click", async () => {
    triageButton.disabled = true;
    setStatus(`Starting triage for issue #${issue.id}...`, "info");
    try {
      await postJson(`/api/issues/${issue.id}/triage`);
      setStatus(`Triage started for issue #${issue.id}.`, "info");
      await loadDashboard();
    } catch (error) {
      triageButton.disabled = false;
      setStatus(`Unable to start triage for #${issue.id}: ${error.message}`, "error");
    }
  });

  fixButton.addEventListener("click", async () => {
    fixButton.disabled = true;
    setStatus(`Launching fix session for issue #${issue.id}...`, "info");
    try {
      await postJson(`/api/issues/${issue.id}/fix`);
      setStatus(`Fix session started for issue #${issue.id}.`, "info");
      await loadDashboard();
    } catch (error) {
      fixButton.disabled = false;
      setStatus(`Unable to launch fix for #${issue.id}: ${error.message}`, "error");
    }
  });

  if (automation.kind === "fix" && automation.pullRequestUrl) {
    const pr = document.createElement("a");
    pr.href = automation.pullRequestUrl;
    pr.target = "_blank";
    pr.rel = "noreferrer";
    pr.className = "session-link visible";
    pr.textContent = "Open PR";
    node.querySelector(".actions").append(pr);
  }

  return node;
}

function buildFlagCard(flag) {
  const node = flagTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".flag-key").textContent = flag.key;
  node.querySelector(".flag-owner").textContent = `${titleCase(flag.owner || "team")} · ${titleCase(flag.area || "unknown")}`;
  node.querySelector(".flag-status").textContent = titleCase(flag.status || "active");
  node.querySelector(".flag-description").textContent = flag.description;

  const removeButton = node.querySelector(".flag-remove-action");
  const sessionLink = node.querySelector(".flag-session-link");
  const automation = flag.automation || {};

  removeButton.disabled = automation.status === "running";
  if (automation.sessionUrl) {
    sessionLink.href = automation.sessionUrl;
    sessionLink.textContent = "Open Devin Session";
    sessionLink.classList.add("visible");
  }
  if (automation.kind === "feature_flag_removal" && automation.pullRequestUrl) {
    const pr = document.createElement("a");
    pr.href = automation.pullRequestUrl;
    pr.target = "_blank";
    pr.rel = "noreferrer";
    pr.className = "session-link visible";
    pr.textContent = "Open PR";
    node.querySelector(".actions").append(pr);
  }

  removeButton.addEventListener("click", async () => {
    removeButton.disabled = true;
    setStatus(`Starting feature-flag removal for ${flag.key}...`, "info");
    try {
      await postJson(`/api/flags/${encodeURIComponent(flag.key)}/remove`);
      setStatus(`Feature-flag removal started for ${flag.key}.`, "info");
      await loadDashboard();
    } catch (error) {
      removeButton.disabled = false;
      setStatus(`Unable to start feature-flag removal for ${flag.key}: ${error.message}`, "error");
    }
  });

  return node;
}

function setStatus(message, kind = "info") {
  if (!message) {
    statusBanner.textContent = "";
    statusBanner.className = "status-banner";
    return;
  }
  statusBanner.textContent = message;
  statusBanner.className = `status-banner visible ${kind}`;
}

function setPolling(intervalMs) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadDashboard, intervalMs);
}

function setActiveTab(tabName) {
  activeTab = tabName;
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.dataset.tabPanel === tabName;
    panel.classList.toggle("active", isActive);
    panel.setAttribute("aria-hidden", String(!isActive));
  });
}

function initializeTabs() {
  for (const button of tabButtons) {
    button.addEventListener("click", () => {
      setActiveTab(button.dataset.tab || "issues");
    });
  }

  setActiveTab(activeTab);
}

async function postJson(url) {
  const response = await fetch(url, { method: "POST" });
  if (response.ok) return response.json().catch(() => ({}));

  let message = `Request failed (${response.status})`;
  try {
    const payload = await response.json();
    if (payload?.error) message = payload.error;
  } catch {
    // Keep generic message if body is not JSON.
  }
  throw new Error(message);
}

function buildRenderKey(data) {
  return JSON.stringify({
    codeql: {
      status: data.codeql?.status,
      summary: data.codeql?.summary,
      repo: data.codeql?.repo,
      repoSource: data.codeql?.repoSource,
      workflowUrl: data.codeql?.workflowUrl,
      actionsUrl: data.codeql?.actionsUrl,
      latestRunId: data.codeql?.latestRun?.id,
      latestRunStatus: data.codeql?.latestRun?.status,
      latestRunConclusion: data.codeql?.latestRun?.conclusion,
      latestRunUpdatedAt: data.codeql?.latestRun?.updatedAt
    },
    integrations: (data.integrations || []).map((integration) => ({
      id: integration.id,
      connected: integration.connected,
      url: integration.url
    })),
    issues: data.issues.map((issue) => ({
      id: issue.id,
      score: issue.score?.total,
      automation: issue.automation,
      sourceUrl: issue.source?.url || null,
      githubIssueState: issue.githubIssueState || null
    })),
    flags: (data.flags || []).map((flag) => ({
      key: flag.key,
      automation: flag.automation
    })),
    events: data.events.map((event) => event.id)
  });
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  const seconds = Math.round(durationMs / 1000);
  return `${seconds}s`;
}

function setActionLink(node, text, href) {
  if (!href) {
    node.classList.remove("visible");
    node.removeAttribute("href");
    node.textContent = "";
    return;
  }
  node.href = href;
  node.textContent = text;
  node.classList.add("visible");
}

function renderCodeqlProof(codeql) {
  const latestRun = codeql?.latestRun || null;
  const statusLabel = latestRun
    ? `Run: ${titleCase(latestRun.status || "unknown")}${latestRun.conclusion ? ` (${titleCase(latestRun.conclusion)})` : ""}`
    : `State: ${titleCase(codeql?.status || "unknown")}`;
  const branchLabel = latestRun?.branch ? `Branch: ${latestRun.branch}` : "Branch: n/a";
  const duration = formatDuration(latestRun?.durationMs);
  const summarySuffix = latestRun?.updatedAt
    ? ` Last updated ${new Date(latestRun.updatedAt).toLocaleString()}${duration ? ` · Duration ${duration}` : ""}.`
    : "";

  const sourceLabel =
    codeql?.repoSource === "env"
      ? "configured"
      : codeql?.repoSource === "seeded_issues"
        ? "inferred from seeded issues"
        : "not configured";
  codeqlSummary.textContent = `${codeql?.summary || "CodeQL proof data unavailable."}${summarySuffix}`;
  codeqlRepo.textContent = `Repo: ${codeql?.repo || "Not configured"} (${sourceLabel})`;
  codeqlStatus.textContent = statusLabel;
  codeqlBranch.textContent = branchLabel;

  if (latestRun?.status === "completed" && latestRun?.conclusion === "success") {
    codeqlTalkTrack.textContent =
      "Demo line: This run proves the CodeQL batch workflow is live. When open critical/high/medium alerts exist, it launches Devin sessions in batches and tracks them via this workflow.";
  } else if (codeql?.status === "not_configured") {
    codeqlTalkTrack.textContent =
      "Demo line: Configure CODEQL_TARGET_REPO or DEVIN_REPOS to bind this panel to a repository, then use Open Workflow to run the batch job.";
  } else if (latestRun?.status === "completed" && latestRun?.conclusion && latestRun?.conclusion !== "success") {
    codeqlTalkTrack.textContent =
      "Demo line: The workflow executed but ended with a non-success conclusion. Open the run to show diagnostics and remediation details.";
  } else if (latestRun) {
    codeqlTalkTrack.textContent =
      "Demo line: The workflow is actively running. Once complete, this card will show final proof of batch execution results.";
  } else {
    codeqlTalkTrack.textContent =
      "Demo line: Trigger the CodeQL batch workflow from GitHub Actions to produce proof here.";
  }
  setActionLink(
    codeqlRunLink,
    latestRun?.runNumber ? `Open Workflow Run #${latestRun.runNumber}` : "Open Latest Workflow Run",
    latestRun?.url || codeql?.workflowRunsUrl || null
  );
  setActionLink(codeqlWorkflowLink, "Open Workflow", codeql?.workflowUrl || codeql?.workflowRunsUrl || null);
  setActionLink(codeqlActionsLink, "Open GitHub Actions", codeql?.actionsUrl || null);
}

function renderIntegrations(integrations) {
  const chips = (integrations || []).map((integration) => {
    const node = document.createElement(integration.url ? "a" : "span");
    node.className = `integration-chip ${integration.connected ? "connected" : "disconnected"}`;
    if (integration.url) {
      node.href = integration.url;
      node.target = "_blank";
      node.rel = "noreferrer";
    }
    node.title = integration.detail || "";

    const dot = document.createElement("span");
    dot.className = "integration-dot";
    const label = document.createElement("span");
    const icon =
      integration.id === "github" ? "GH" : integration.id === "linear" ? "LN" : integration.id === "slack" ? "SL" : "";
    label.textContent = `${icon} ${integration.label} ${integration.connected ? "Connected" : "Missing"}`;
    node.append(dot, label);
    return node;
  });

  integrationList.replaceChildren(...chips);
}

function buildActivityItem(event) {
  const wrapper = document.createElement("article");
  wrapper.className = `activity-item ${event.type || ""}`;
  const time = document.createElement("time");
  time.textContent = new Date(event.createdAt).toLocaleString();
  const badge = document.createElement("span");
  badge.className = "activity-badge";
  badge.textContent =
    event.type === "slack_message"
      ? "Slack"
      : event.type === "linear_sync"
        ? "Linear"
        : event.type === "completed"
          ? "Completed"
          : event.type === "flag_removal_started"
            ? "Flag"
          : event.type === "fix_started"
            ? "Fix"
            : event.type === "triage_started"
              ? "Triage"
              : "Update";
  const copy = document.createElement("p");
  copy.textContent = event.detail;
  wrapper.append(time, badge, copy);
  return wrapper;
}

async function loadDashboard() {
  try {
    const response = await fetch("/api/dashboard");
    if (!response.ok) throw new Error(`Dashboard refresh failed (${response.status})`);
    const data = await response.json();
    modePill.textContent = data.mode === "live" ? "Live Devin API" : "Mock Devin API";
    issueCount.textContent = String(data.issues.length);

    const nextRenderKey = buildRenderKey(data);
    if (nextRenderKey !== lastRenderKey) {
      renderIntegrations(data.integrations);
      renderCodeqlProof(data.codeql);
      issueList.replaceChildren(...data.issues.map(buildIssueCard));
      flagList.replaceChildren(...(data.flags || []).map(buildFlagCard));
      activityList.replaceChildren(...data.events.map(buildActivityItem));
      lastRenderKey = nextRenderKey;
    }

    const hasRunningAutomation =
      data.issues.some((issue) => issue.automation?.status === "running") ||
      (data.flags || []).some((flag) => flag.automation?.status === "running");
    setPolling(hasRunningAutomation ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  } catch (error) {
    setStatus(error.message, "error");
    setPolling(POLL_IDLE_MS);
  }
}

syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  try {
    await postJson("/api/sync");
    await loadDashboard();
    setStatus("Status refreshed.", "info");
  } catch (error) {
    setStatus(`Refresh failed: ${error.message}`, "error");
  } finally {
    syncButton.disabled = false;
  }
});

resetButton.addEventListener("click", async () => {
  resetButton.disabled = true;
  try {
    await postJson("/api/reset");
    lastRenderKey = "";
    await loadDashboard();
    setStatus("Demo state reset. Ready for a fresh walkthrough.", "info");
  } catch (error) {
    setStatus(`Reset failed: ${error.message}`, "error");
  } finally {
    resetButton.disabled = false;
  }
});

initializeTabs();
loadDashboard();
