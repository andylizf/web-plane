import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { paths } from './config.js';
import { sessionEvidencePaths } from './profile-runtime.js';

function safeLane(lane) {
  const label = encodeURIComponent(lane).slice(0, 80);
  const hash = createHash('sha256').update(lane).digest('hex').slice(0, 12);
  return `${label}-${hash}`;
}

export function laneEventsPath(session, lane) {
  return join(sessionEvidencePaths(session).dir, `${safeLane(lane)}.events.jsonl`);
}

function cursorPath(session, lane) {
  const key = createHash('sha256').update(`${session}\0${lane}`).digest('hex');
  return join(paths.runDir, `.lane-events-cursor-${key}.json`);
}

export function appendLaneEvent(session, lane, event) {
  const path = laneEventsPath(session, lane);
  mkdirSync(sessionEvidencePaths(session).dir, { recursive: true, mode: 0o700 });
  const record = { timestamp: new Date().toISOString(), lane, ...event };
  // Request/response bodies and headers can contain credentials. The monitor's
  // contract is metadata only, even if a caller accidentally supplies more.
  delete record.requestBody;
  delete record.responseBody;
  delete record.headers;
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, record };
}

function parseLines(content) {
  const records = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object') records.push(record);
    } catch {}
  }
  return records;
}

export function readLaneEvents(session, lane) {
  const path = laneEventsPath(session, lane);
  if (!existsSync(path)) return [];
  return parseLines(readFileSync(path, 'utf8'));
}

export function laneEventOffset(session, lane) {
  try {
    return statSync(laneEventsPath(session, lane)).size;
  } catch {
    return 0;
  }
}

export function readLaneEventsAfter(session, lane, offset) {
  const path = laneEventsPath(session, lane);
  if (!existsSync(path)) return [];
  const data = readFileSync(path);
  return parseLines(data.subarray(Math.max(0, Math.min(offset, data.length))).toString('utf8'));
}

export function setLaneEventCursor(session, lane, offset) {
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    cursorPath(session, lane),
    `${JSON.stringify({ session, lane, offset, timestamp: new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );
}

export function laneEventCursor(session, lane) {
  try {
    const state = JSON.parse(readFileSync(cursorPath(session, lane), 'utf8'));
    return state.session === session && state.lane === lane && Number.isInteger(state.offset)
      ? state.offset
      : 0;
  } catch {
    return 0;
  }
}

export function parseNetlogArgs(args) {
  const rest = args[0] === 'netlog' ? args.slice(1) : [...args];
  let failed = false;
  let clear = false;
  let sinceSeconds = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--failed') failed = true;
    else if (arg === '--clear') clear = true;
    else if (arg === '--since') {
      const value = rest[++i];
      if (!value || !/^\d+(?:\.\d+)?$/.test(value)) {
        throw new Error('--since expects a number of seconds');
      }
      sinceSeconds = Number(value);
    } else {
      throw new Error(`unknown netlog argument '${arg}'`);
    }
  }
  return { failed, sinceSeconds, clear };
}

function isFailed(event) {
  return ['request-failed', 'response-failed'].includes(event.type);
}

export function formatNetlog(events, { failed = false } = {}) {
  const selected = failed ? events.filter(isFailed) : events;
  if (!selected.length) return failed ? 'No failed requests.' : 'No lane events.';
  return selected.map((event) => {
    const time = event.timestamp ?? '(unknown time)';
    if (event.type === 'request-failed') {
      return `${time} ${event.method ?? 'REQUEST'} ${event.url ?? '(unknown URL)'} — ${event.errorText ?? 'failed'}`;
    }
    if (event.type === 'response-failed') {
      return `${time} ${event.method ?? 'REQUEST'} ${event.url ?? '(unknown URL)'} — HTTP ${event.status ?? 'error'}`;
    }
    if (event.type === 'console') return `${time} console.${event.level ?? 'log'}: ${event.text ?? ''}`;
    if (event.type === 'page-error') return `${time} page error: ${event.text ?? ''}`;
    if (event.type === 'browser-disconnected') return `${time} browser disconnected`;
    return `${time} ${event.type ?? 'event'}`;
  }).join('\n');
}

export function eventWarnings(events) {
  return events.flatMap((event) => {
    if (event.type === 'console' && event.level === 'error') {
      return [`console.error: ${event.text ?? '(no text)'}`];
    }
    if (event.type === 'page-error') return [`page error: ${event.text ?? '(no text)'}`];
    if (event.type === 'request-failed') {
      return [`failed request: ${event.method ?? 'REQUEST'} ${event.url ?? '(unknown URL)'} — ${event.errorText ?? 'failed'}`];
    }
    if (event.type === 'response-failed') {
      return [`failed response: ${event.method ?? 'REQUEST'} ${event.url ?? '(unknown URL)'} — HTTP ${event.status ?? 'error'}`];
    }
    return [];
  });
}

const FAILURE_TRIGGERING_COMMANDS = new Set([
  'check', 'click', 'dblclick', 'drag', 'fill', 'goto', 'keyboard', 'navigate',
  'open', 'press', 'select', 'type', 'uncheck', 'upload',
]);

export function laneCommandMayTriggerPageFailures(args) {
  return FAILURE_TRIGGERING_COMMANDS.has(args[0]);
}

export function runNetlog(session, lane, args) {
  let options;
  try {
    options = parseNetlogArgs(args);
  } catch (error) {
    return { status: 2, output: `web-plane: ${error.message}` };
  }
  const path = laneEventsPath(session, lane);
  if (options.clear) {
    const offset = laneEventOffset(session, lane);
    setLaneEventCursor(session, lane, offset);
    return {
      status: 0,
      output: `Lane event cursor advanced; evidence was preserved at ${path}`,
    };
  }
  let events = readLaneEventsAfter(session, lane, laneEventCursor(session, lane));
  if (options.sinceSeconds != null) {
    const cutoff = Date.now() - options.sinceSeconds * 1000;
    events = events.filter((event) => Date.parse(event.timestamp) >= cutoff);
  }
  return { status: 0, output: formatNetlog(events, options) };
}
