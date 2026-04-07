import fs from "node:fs/promises";
import path from "node:path";

const STATE_PATH = path.resolve("data/state.json");
const DEFAULT_STATE = {
  automationRuns: {},
  flagRuns: {},
  events: [],
  linearIssueMap: {},
  linearStateMap: {}
};

async function ensureState() {
  try {
    await fs.access(STATE_PATH);
  } catch {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(
      STATE_PATH,
      JSON.stringify(DEFAULT_STATE, null, 2),
      "utf8"
    );
  }
}

export async function readState() {
  await ensureState();
  const raw = await fs.readFile(STATE_PATH, "utf8");
  return JSON.parse(raw);
}

export async function writeState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

export async function mutateState(mutator) {
  const state = await readState();
  const next = await mutator(state);
  await writeState(next);
  return next;
}

export function createEvent(type, issueId, detail) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    issueId,
    detail,
    createdAt: new Date().toISOString()
  };
}
