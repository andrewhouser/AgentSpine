/**
 * The tool registry — the complete set of capabilities that exist. Adding a tool
 * here is the only way to give the agent a new power, and every tool is still
 * subject to the broker's allowlist + reversibility gates.
 *
 */
import type { Tool } from "../types.ts";
import { macControl } from "./mac-control.ts";
import { webSearch } from "./web-search.ts";
import { webRead } from "./web-read.ts";
import { browserControl } from "./browser.ts";
import { readFile, listDir } from "./read-file.ts";
import { readMoreTool } from "./read-more.ts";
import { gmailSearch } from "./gmail.ts";
import { calendarUpcoming } from "./calendar.ts";
import { memorySave, memoryRecall } from "./memory.ts";
import { conversationDetail } from "./conversation.ts";
import { notifyTool } from "./notify.ts";
import { stateGet, stateSet } from "./state.ts";
import { scheduleCreate, scheduleDelete, scheduleList, scheduleUpdate } from "./schedule.ts";
import { weather } from "./weather.ts";
import { weatherAlerts } from "./weather-alerts.ts";
import { gitStatus } from "./git-status.ts";
import { digestTool } from "./digest.ts";
import { draft } from "./draft.ts";
import { subagent } from "./subagent.ts";

export const tools: Tool[] = [
  macControl,
  notifyTool,
  webSearch,
  webRead,
  browserControl,
  readFile,
  listDir,
  readMoreTool,
  gmailSearch,
  calendarUpcoming,
  memorySave,
  memoryRecall,
  conversationDetail,
  stateGet,
  stateSet,
  scheduleList,
  scheduleCreate,
  scheduleUpdate,
  scheduleDelete,
  weather,
  weatherAlerts,
  gitStatus,
  digestTool,
  draft,
  subagent,
];

export const registry: Record<string, Tool> = Object.fromEntries(tools.map((t) => [t.name, t]));
