import {
  TRIAGE_SCHEMA,
  buildFeatureFlagRemovalPrompt,
  buildFixPrompt,
  buildTriagePrompt,
  mockTriage
} from "./issue-engine.mjs";

const DEFAULT_BASE_URL = process.env.DEVIN_API_BASE_URL || "https://api.devin.ai";

function getKeyType() {
  if (process.env.DEVIN_API_KEY?.startsWith("cog_")) return "service_user";
  if (process.env.DEVIN_API_KEY?.startsWith("apk_user_")) return "personal_legacy";
  if (process.env.DEVIN_API_KEY?.startsWith("apk_")) return "service_legacy";
  return process.env.DEVIN_API_KEY ? "unknown" : "missing";
}

function getApiVersion() {
  if (process.env.DEVIN_API_VERSION && process.env.DEVIN_API_VERSION !== "auto") {
    return process.env.DEVIN_API_VERSION;
  }

  if (getKeyType() === "service_user") return "v3";
  if (getKeyType() === "personal_legacy" || getKeyType() === "service_legacy") return "v1";
  return process.env.DEVIN_ORG_ID ? "v3" : "v1";
}

function hasApiKey() {
  if (!process.env.DEVIN_API_KEY) return false;
  if (getApiVersion() === "v3") return Boolean(process.env.DEVIN_ORG_ID);
  return true;
}

function getOrgPath() {
  if (!process.env.DEVIN_ORG_ID) {
    throw new Error("Missing DEVIN_ORG_ID for live Devin API mode.");
  }
  return `/v3/organizations/${process.env.DEVIN_ORG_ID}/sessions`;
}

function getCreateSessionPath() {
  return getApiVersion() === "v3" ? getOrgPath() : "/v1/sessions";
}

function getSessionPath(sessionId) {
  return getApiVersion() === "v3" ? `${getOrgPath()}/${sessionId}` : `/v1/sessions/${sessionId}`;
}

async function devinFetch(path, options = {}) {
  const response = await fetch(`${DEFAULT_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEVIN_API_KEY}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Devin API error ${response.status}: ${text}`);
  }

  return response.json();
}

function createMockSession(prefix, issueId, extra = {}) {
  const now = Date.now();
  return {
    session_id: `${prefix}-${issueId}-${now}`,
    status: "running",
    status_enum: "working",
    title: extra.title || null,
    url: `https://app.devin.ai/sessions/${prefix}-${issueId}-${now}`,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    structured_output: extra.structured_output || null,
    pull_request: extra.pull_request || null
  };
}

export function getMode() {
  return hasApiKey() ? "live" : "mock";
}

export function getDevinConfigStatus() {
  const apiVersion = getApiVersion();
  const keyType = getKeyType();
  return {
    mode: getMode(),
    apiVersion,
    keyType,
    apiBaseUrl: DEFAULT_BASE_URL,
    hasApiKey: Boolean(process.env.DEVIN_API_KEY),
    apiKeyLooksLikeServiceUser: keyType === "service_user",
    apiKeyLooksLikeLegacyPersonal: keyType === "personal_legacy",
    hasOrgId: Boolean(process.env.DEVIN_ORG_ID),
    orgIdRequired: apiVersion === "v3",
    hasRepos: Boolean(process.env.DEVIN_REPOS),
    repos: (process.env.DEVIN_REPOS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    hasCreateAsUserId: Boolean(process.env.DEVIN_CREATE_AS_USER_ID),
    createAsUserIdSupported: apiVersion === "v3",
    readyForLive: hasApiKey()
  };
}

function getSessionOptions() {
  if (getApiVersion() !== "v3") return {};

  const repos = (process.env.DEVIN_REPOS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    repos,
    ...(process.env.DEVIN_CREATE_AS_USER_ID
      ? { create_as_user_id: process.env.DEVIN_CREATE_AS_USER_ID }
      : {})
  };
}

export async function createTriageSession(issue) {
  if (!hasApiKey()) {
    return createMockSession("mock-triage", issue.id, {
      title: `Issue #${issue.id} triage`,
      structured_output: mockTriage(issue)
    });
  }

  return devinFetch(getCreateSessionPath(), {
    method: "POST",
    body: JSON.stringify({
      title: `Issue #${issue.id} triage`,
      prompt: buildTriagePrompt(issue),
      tags: ["cognition-demo", "triage", `issue-${issue.id}`],
      structured_output_schema: TRIAGE_SCHEMA,
      max_acu_limit: 2,
      ...getSessionOptions()
    })
  });
}

export async function createFixSession(issue, triage) {
  if (!hasApiKey()) {
    return createMockSession("mock-fix", issue.id, {
      title: `Issue #${issue.id} fix`,
      pull_request: {
        url: `https://github.com/acme/finserv/pull/${issue.id}`
      }
    });
  }

  return devinFetch(getCreateSessionPath(), {
    method: "POST",
    body: JSON.stringify({
      title: `Issue #${issue.id} fix`,
      prompt: buildFixPrompt(issue, triage),
      tags: ["cognition-demo", "fix", `issue-${issue.id}`],
      max_acu_limit: 8,
      ...getSessionOptions()
    })
  });
}

export async function createFeatureFlagRemovalSession(flag) {
  if (!hasApiKey()) {
    return createMockSession("mock-flag-remove", flag.key.replaceAll(".", "-"), {
      title: `Remove flag ${flag.key}`,
      pull_request: {
        url: `https://github.com/acme/finserv/pull/${Date.now() % 10000}`
      }
    });
  }

  return devinFetch(getCreateSessionPath(), {
    method: "POST",
    body: JSON.stringify({
      title: `Remove feature flag ${flag.key}`,
      prompt: buildFeatureFlagRemovalPrompt(flag),
      tags: ["cognition-demo", "feature-flag", `flag-${flag.key.replaceAll(".", "-")}`],
      max_acu_limit: 8,
      ...getSessionOptions()
    })
  });
}

function mockStatusForRun(run) {
  const created = new Date(run.createdAt).getTime();
  const elapsedSeconds = Math.floor((Date.now() - created) / 1000);

  if (run.kind === "triage") {
    if (elapsedSeconds < 2) return "running";
    return "completed";
  }

  if (elapsedSeconds < 3) return "running";
  if (elapsedSeconds < 8) return "running";
  return "completed";
}

export async function getSession(sessionId, run) {
  if (!hasApiKey()) {
    const status = mockStatusForRun(run);
    return {
      session_id: sessionId,
      status: status === "completed" ? "completed" : "running",
      status_enum: status === "completed" ? "finished" : "working",
      updated_at: new Date().toISOString(),
      structured_output: run.kind === "triage" ? run.triage : undefined,
      pull_request:
        run.kind === "fix" && status === "completed"
          ? { url: `https://github.com/acme/finserv/pull/${run.issueId}` }
          : null
    };
  }

  return devinFetch(getSessionPath(sessionId), { method: "GET" });
}
