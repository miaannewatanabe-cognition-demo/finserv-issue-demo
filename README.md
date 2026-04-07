# Issue Avalanche

Issue Avalanche is a Devin automation demo for **Client A: FinServ Co**. It addresses the "300+ stale issues" problem by combining:

- **(1) GitHub Issues automation**: rank, triage, and launch autonomous fixes
- **(2) Feature flag removal dashboard**: trigger cleanup sessions that open PRs
- **(3) CodeQL fix batching proof**: GitHub Action that launches Devin sessions in batches

It also includes **Slack + Linear integration** so stakeholders can see real status updates in systems they already use.

## What is implemented

### 1) GitHub issues integration

- Loads a ranked issue queue from seeded GitHub-linked issues
- Runs Devin triage with structured output (confidence, plan, missing info)
- Launches a fix session from approved triage output
- Surfaces session links and PR links in the UI

### 2) Feature flag removal dashboard

- Shows existing feature flags from `data/feature-flags.json`
- Launches dedicated Devin sessions per flag
- Tracks completion and PR links

### 3) CodeQL security batching

- GitHub workflow: `.github/workflows/codeql-devin-fixes.yml`
- Batch runner script: `.github/scripts/codeql-devin-batches.mjs`
- Dashboard proof card shows latest workflow run status + links

## Integrations included

- **GitHub**: issue links, PR links, and workflow run proof
- **Slack**: live notifications for triage/fix/flag milestones
- **Linear**: issue/comment sync and state transitions (`In Progress`, `In Review`)

## Local setup

```bash
cp .env.example .env
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

### Required for live Devin mode

```bash
DEVIN_API_KEY=
DEVIN_ORG_ID=
DEVIN_REPOS=github.com/<owner>/<repo>
```

`DEVIN_API_VERSION=auto` works for both legacy and v3 credentials.

### Recommended for full demo quality

```bash
SLACK_BOT_TOKEN=
SLACK_CHANNEL_ID=
LINEAR_API_KEY=
LINEAR_TEAM_KEY=
LINEAR_IN_PROGRESS_STATE_NAME=In Progress
LINEAR_IN_REVIEW_STATE_NAME=In Review
GITHUB_TOKEN=
```

### Optional CodeQL proof controls

```bash
CODEQL_TARGET_REPO=<owner>/<repo>
CODEQL_WORKFLOW_NAME=CodeQL Devin Fix Batches
```

If `CODEQL_TARGET_REPO` is omitted, the app uses the first repo in `DEVIN_REPOS`.

## Demo day clean slate checklist

1. Start server (`npm start`)
2. In dashboard click **Reset Demo State**
3. Confirm status feed is empty and no running sessions are shown
4. Confirm CodeQL proof card shows latest workflow state
5. Open Slack + Linear side-by-side for live update proof
6. Keep one GitHub issue and one feature flag path ready for narration

## 5-minute Loom script (submission-ready)

1. **Problem framing (30s)**  
   "FinServ has hundreds of stale issues and limited senior bandwidth."
2. **Issue automation (2m)**  
   Show ranked queue -> run triage -> explain structured confidence -> launch fix -> show status/PR handoff.
3. **Integration proof (1m)**  
   Show Slack message + Linear state transition triggered by the workflow.
4. **Feature flag workflow (45s)**  
   Trigger a flag removal session and show session/PR tracking.
5. **Security workflow proof (45s)**  
   Show CodeQL proof card and open workflow run link in GitHub Actions.

If no open critical/high/medium alerts exist, narrate this as a valid outcome:
"The batch workflow is active and ready; current posture is clean for selected severities."

## Testing

```bash
npm test
```

## Key files

- `src/server.mjs` - API routes, integration orchestration, CodeQL proof fetch
- `src/lib/devin-client.mjs` - Devin v1/v3 client adapter
- `src/lib/issue-engine.mjs` - scoring and prompt builders
- `src/lib/store.mjs` - state management
- `public/index.html` - dashboard layout
- `public/app.js` - client rendering/actions
- `public/styles.css` - UI styles
- `.github/workflows/codeql-devin-fixes.yml` - CodeQL batch workflow
- `.github/scripts/codeql-devin-batches.mjs` - CodeQL alert batching + Devin session launcher
