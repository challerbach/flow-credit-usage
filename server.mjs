#!/usr/bin/env node
// Flow Credit Usage: a local app that shows the Amplience credits a Workforce flow used.
//
//   npm start                      (or: node server.mjs)  ->  http://localhost:4310
//
// Data sources (Amplience GraphQL API, https://api.amplience.net/graphql, personal access token):
//   - viewer.organizations.cmsHubs      the hubs the token can see (chosen in the app; HUB_ID preselects one)
//   - cmsHub.contentFlows               the flows of the hub
//   - contentFlow.runs                  run status, joined to the credit entries
//   - organization.creditBalance        balance and allowance of the organisation
//   - organization.creditTransactionReport(format: JSON)
//                                       the organisation's credit report for a year; every entry
//                                       carries workflowId / workflowRunId / cmsHubId attributes and
//                                       line items with unit, quantity, credits and actionLabel.
//
// The token comes from AMPLIENCE_PAT (environment or .env.local) or is entered in the app; it is
// kept in memory, sent only to the GraphQL API and never written to disk or returned to the browser.
// No dependencies, Node 18+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// .env.local (KEY=value lines), environment wins
const envFile = path.join(ROOT, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const PORT = Number(process.env.PORT) || 4310;
const HUB_ID = (process.env.HUB_ID || '63ead78ae00d9500019756b8').trim(); // preselected hub
const GRAPHQL = process.env.AMPLIENCE_GRAPHQL_URL || 'https://api.amplience.net/graphql';
const REPORT_TTL_MS = 10 * 60 * 1000;

let token = process.env.AMPLIENCE_PAT?.trim() || '';
let hubList; // [{ org, hub }] for the current token, from viewer
const reportCache = new Map(); // `${orgId}:${year}` -> { at, records }

// ---------- helpers ----------

class ApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const unb64 = (s) => {
  try {
    return Buffer.from(String(s), 'base64').toString('utf8');
  } catch {
    return '';
  }
};

/** IDs appear as GraphQL IDs (base64 "Type:value") or as plain values: compare on the plain, lower-case value. */
export function normId(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (/^[A-Za-z0-9+/]+=*$/.test(s) && s.length >= 8) {
    const d = unb64(s);
    const m = d.match(/^[A-Za-z]+:(.+)$/);
    if (m && /^[\x20-\x7e]+$/.test(d)) return m[1].toLowerCase();
  }
  return s.toLowerCase();
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Run IDs: the report and the GraphQL API may wrap the run UUID differently; compare on the UUID. */
export function runKey(v) {
  const n = normId(v);
  const m = n.match(UUID);
  return m ? m[m.length - 1] : n;
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const kv = (attrs) => {
  if (!attrs) return {};
  if (Array.isArray(attrs)) return Object.fromEntries(attrs.filter((a) => a && a.key !== undefined).map((a) => [a.key, a.value]));
  return typeof attrs === 'object' ? attrs : {};
};

async function gql(query, variables) {
  if (!token) throw new ApiError('No personal access token yet.', 401);
  let res;
  try {
    res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });
  } catch (e) {
    throw new ApiError(`The Amplience GraphQL API could not be reached (${e.message}).`);
  }
  const json = await res.json().catch(() => ({}));
  const errs = json.errors?.map((e) => e.message).filter(Boolean);
  if (errs?.length) throw new ApiError([...new Set(errs)].join('; '), res.status === 401 ? 401 : 502);
  if (!res.ok || !json.data) throw new ApiError(`The Amplience GraphQL API answered HTTP ${res.status}.`, res.status === 401 ? 401 : 502);
  return json.data;
}

// ---------- GraphQL ----------

const Q_VIEWER = `query viewerHubs { viewer { email organizations(first: 50) { edges { node { id name label cmsHubs { id name label cmsHubId } } } } } }`;
const Q_BALANCE = `query balance($id: ID!) { organization(id: $id) { creditBalance { balance creditAllowance quotaPeriod } } }`;
const Q_FLOWS = `query flows($id: ID!, $after: String) { cmsHub(id: $id) { contentFlows(first: 50, after: $after) { edges { node { id label status lastRunDate } } pageInfo { hasNextPage endCursor } } } }`;
const Q_RUNS = `query runs($id: ID!, $after: String) { contentFlow(id: $id) { runs(first: 50, after: $after) { edges { node { id label status createdDate updatedDate } } pageInfo { hasNextPage endCursor } } } }`;
const Q_REPORT = `query report($id: ID!, $input: CreditTransactionReportFilterInput) { organization(id: $id) { creditTransactionReport(input: $input) { reportURL } } }`;

/** All CMS hubs the token can see: [{ org: { id, label }, hub: { id, label, key, dcHubId } }]. */
async function listHubs() {
  if (hubList) return hubList;
  const viewer = (await gql(Q_VIEWER)).viewer;
  hubList = (viewer?.organizations?.edges ?? []).flatMap((e) =>
    (e.node?.cmsHubs ?? []).map((h) => {
      const key = normId(h.id); // "<org>/<hub>"
      return {
        org: { id: e.node.id, label: e.node.label ?? e.node.name },
        hub: { id: h.id, label: h.label ?? h.name, key, dcHubId: h.cmsHubId ?? key.split('/')[1] ?? '' },
      };
    }),
  );
  hubList.sort((a, b) => `${a.org.label} ${a.hub.label}`.localeCompare(`${b.org.label} ${b.hub.label}`));
  return hubList;
}

/** The hub for a Dynamic Content hub ID (or the hub's GraphQL ID). */
async function resolveHub(hubId) {
  if (!hubId) throw new ApiError('Choose a hub.', 400);
  const id = String(hubId).toLowerCase();
  const hubs = await listHubs();
  const hit = hubs.find((x) => String(x.hub.dcHubId).toLowerCase() === id || x.hub.key.endsWith(`/${id}`) || x.hub.key === normId(hubId));
  if (!hit) throw new ApiError(`No hub with ID ${hubId} for this token.`, 404);
  return hit;
}

async function paged(query, id, pick, max) {
  const out = [];
  let after;
  do {
    const conn = pick(await gql(query, { id, after }));
    if (!conn) break;
    out.push(...(conn.edges ?? []).map((e) => e.node).filter(Boolean));
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : undefined;
  } while (after && out.length < max);
  return out;
}

// ---------- credit report ----------

/** Report text -> array of raw entries (JSON array, object with an array, or JSON lines). */
export function parseReport(text) {
  const t = text.trim();
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
    if (j && typeof j === 'object') {
      for (const k of ['records', 'transactions', 'data', 'items', 'entries', 'results']) if (Array.isArray(j[k])) return j[k];
      const arr = Object.values(j).find(Array.isArray);
      if (arr) return arr;
      return [j];
    }
  } catch {
    /* JSON lines */
  }
  return t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

/** One raw report entry -> normalised entry. */
export function normaliseEntry(r) {
  const payload = r?.event?.payload ?? r?.payload ?? {};
  const attrs = kv(payload.attributes ?? r?.attributes);
  const items = (payload.lineItems ?? r?.lineItems ?? []).map((li) => {
    const a = kv(li.attributes);
    return { unit: li.unit ?? '?', quantity: num(li.quantity ?? li.amount ?? li.value), credits: num(li.credits), action: a.actionLabel ?? a.actionId ?? a.action ?? '' };
  });
  const itemCredits = items.reduce((s, i) => s + i.credits, 0);
  const change = num(r?.change ?? r?.event?.change ?? r?.event?.payload?.change);
  return {
    date: String(r?.date ?? r?.event?.date ?? r?.createdDate ?? ''),
    requestId: r?.requestId ?? r?.event?.requestId ?? '',
    source: r?.source ?? '',
    type: r?.type ?? r?.event?.type ?? '',
    title: payload.title ?? '',
    hubId: attrs.cmsHubId ?? '',
    flowId: attrs.workflowId ?? '',
    flowLabel: attrs.workflowLabel ?? '',
    runId: attrs.workflowRunId ?? '',
    runLabel: attrs.workflowRunLabel ?? '',
    items,
    credits: items.length && itemCredits ? itemCredits : Math.abs(change),
  };
}

async function loadReport(orgId, year, refresh) {
  const key = `${orgId}:${year}`;
  const hit = reportCache.get(key);
  if (hit && !refresh && Date.now() - hit.at < REPORT_TTL_MS) return hit;
  const data = await gql(Q_REPORT, { id: orgId, input: { year: String(year), format: 'JSON' } });
  const url = data.organization?.creditTransactionReport?.reportURL;
  if (!url) throw new ApiError(`No credit report for ${year}. Reading the credit report needs organisation admin rights.`, 404);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new ApiError(`The credit report could not be downloaded (${e.message}).`);
  }
  if (!res.ok) throw new ApiError(`The credit report download answered HTTP ${res.status}.`);
  const raw = parseReport(await res.text());
  const entry = { at: Date.now(), records: raw.map(normaliseEntry), sampleKeys: sampleKeys(raw.find((r) => (r?.event?.payload?.lineItems ?? r?.payload?.lineItems ?? r?.lineItems)?.length) ?? raw[0]) };
  reportCache.set(key, entry);
  return entry;
}

/** Key paths of one raw entry (no values), for the diagnostics panel. */
function sampleKeys(obj, prefix = '', out = []) {
  if (!obj || typeof obj !== 'object' || out.length > 60) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      out.push(`${p}[]`);
      if (v[0] && typeof v[0] === 'object') {
        if ('key' in v[0]) out.push(`${p}[].key: ${[...new Set(v.map((x) => x.key))].join(', ')}`);
        else sampleKeys(v[0], `${p}[]`, out);
      }
    } else if (v && typeof v === 'object') sampleKeys(v, p, out);
    else out.push(p);
  }
  return out;
}

// ---------- aggregation ----------

export function aggregate(records, { hub, flow, flowLabel, year, month, runs = [] }) {
  const hubKeys = [normId(hub.id), String(hub.dcHubId).toLowerCase()];
  const inHub = (r) => {
    if (!r.hubId) return true; // entry without hub attribute: decided by the flow ID
    const h = normId(r.hubId);
    return hubKeys.some((k) => k && (h === k || h.includes(k)));
  };
  const prefix = month ? `${year}-${String(month).padStart(2, '0')}` : String(year);
  const inPeriod = (r) => r.date.startsWith(prefix) || (!r.date && !month);
  const workflow = records.filter((r) => r.flowId || r.runId);
  const period = workflow.filter(inPeriod);
  const hubRecords = period.filter(inHub);

  // all flows of the hub in the period
  const byFlow = new Map();
  for (const r of hubRecords) {
    const k = normId(r.flowId) || `label:${r.flowLabel}`;
    const f = byFlow.get(k) ?? { key: k, label: r.flowLabel, credits: 0, runs: new Set(), entries: 0 };
    f.credits += r.credits;
    f.entries += 1;
    if (r.runId) f.runs.add(runKey(r.runId));
    if (r.flowLabel) f.label = r.flowLabel;
    byFlow.set(k, f);
  }
  const hubFlows = [...byFlow.values()].map((f) => ({ ...f, runs: f.runs.size })).sort((a, b) => b.credits - a.credits);
  const hubTotal = hubFlows.reduce((s, f) => s + f.credits, 0);

  const result = { period: prefix, hubTotal, hubFlows, diagnostics: { reportEntries: records.length, workflowEntries: workflow.length, periodEntries: period.length, hubEntries: hubRecords.length } };
  if (!flow) return result;

  const fk = normId(flow);
  let mine = hubRecords.filter((r) => normId(r.flowId) === fk);
  let matchedBy = 'id';
  if (!mine.length && flowLabel) {
    mine = hubRecords.filter((r) => !r.flowId && r.flowLabel === flowLabel);
    matchedBy = mine.length ? 'label' : 'id';
  }

  const runIndex = new Map(runs.map((r) => [runKey(r.id), r]));
  const byRun = new Map();
  const byAction = new Map();
  const byUnit = new Map();
  const byDay = new Map();
  let total = 0;
  for (const r of mine) {
    total += r.credits;
    const rk = runKey(r.runId) || `req:${r.requestId || r.date}`;
    const run = byRun.get(rk) ?? { id: r.runId, label: r.runLabel, first: r.date, last: r.date, credits: 0, entries: 0, actions: new Map() };
    run.credits += r.credits;
    run.entries += 1;
    if (r.date && (!run.first || r.date < run.first)) run.first = r.date;
    if (r.date && r.date > run.last) run.last = r.date;
    if (r.runLabel) run.label = r.runLabel;
    byRun.set(rk, run);
    const day = r.date.slice(0, 10) || 'unknown';
    byDay.set(day, (byDay.get(day) ?? 0) + r.credits);
    const items = r.items.length ? r.items : [{ unit: '(no line items)', quantity: 0, credits: r.credits, action: '' }];
    for (const i of items) {
      const ak = i.action || '(no action label)';
      const a = byAction.get(ak) ?? { action: ak, credits: 0, units: new Set(), calls: 0 };
      a.credits += i.credits;
      a.calls += 1;
      a.units.add(i.unit);
      byAction.set(ak, a);
      const ra = run.actions.get(ak) ?? { action: ak, credits: 0, units: new Set(), calls: 0 };
      ra.credits += i.credits;
      ra.calls += 1;
      ra.units.add(i.unit);
      run.actions.set(ak, ra);
      const u = byUnit.get(i.unit) ?? { unit: i.unit, quantity: 0, credits: 0 };
      u.quantity += i.quantity;
      u.credits += i.credits;
      byUnit.set(i.unit, u);
    }
  }
  const runList = [...byRun.values()]
    .map((r) => {
      const g = runIndex.get(runKey(r.id));
      const actions = [...r.actions.values()].map((a) => ({ ...a, units: [...a.units] })).sort((a, b) => b.credits - a.credits);
      return { ...r, actions, status: g?.status ?? '', started: g?.createdDate ?? r.first };
    })
    .sort((a, b) => String(b.started).localeCompare(String(a.started)));

  result.flow = {
    matchedBy,
    total,
    entries: mine.length,
    runs: runList,
    actions: [...byAction.values()].map((a) => ({ ...a, units: [...a.units] })).sort((a, b) => b.credits - a.credits),
    units: [...byUnit.values()].sort((a, b) => b.credits - a.credits),
    days: [...byDay.entries()].map(([day, credits]) => ({ day, credits })).sort((a, b) => a.day.localeCompare(b.day)),
    runsWithoutCredits: runs.filter((g) => !byRun.has(runKey(g.id)) && String(g.createdDate ?? '').startsWith(prefix)).length,
    runsLoaded: runs.length,
    runsMatched: runList.filter((r) => r.status).length,
    sampleRunId: runs[0] ? normId(runs[0].id) : '',
    sampleReportRunId: mine.find((r) => r.runId)?.runId ?? '',
  };
  return result;
}

// ---------- HTTP ----------

async function readBody(req) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > 1e5) throw new ApiError('Request too large.', 413);
  }
  return s ? JSON.parse(s) : {};
}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};

const routes = {
  'GET /api/status': async () => ({ hasToken: Boolean(token), defaultHubId: HUB_ID }),

  'POST /api/token': async (req) => {
    const { token: t } = await readBody(req);
    if (!t || typeof t !== 'string') throw new ApiError('Enter a personal access token.', 400);
    const previous = token;
    token = t.trim();
    hubList = undefined;
    reportCache.clear();
    try {
      await listHubs();
    } catch (e) {
      token = previous;
      hubList = undefined;
      throw e;
    }
    return { ok: true };
  },

  'GET /api/hubs': async () => {
    const hubs = await listHubs();
    const def = hubs.find((x) => String(x.hub.dcHubId).toLowerCase() === HUB_ID.toLowerCase());
    return {
      defaultHubId: def ? def.hub.dcHubId : hubs[0]?.hub.dcHubId ?? '',
      hubs: hubs.map((x) => ({ dcHubId: x.hub.dcHubId, label: x.hub.label, org: x.org.label })),
    };
  },

  'GET /api/hub': async (req, url) => {
    const ctx = await resolveHub(url.searchParams.get('hub'));
    const [balance, flows] = await Promise.all([
      gql(Q_BALANCE, { id: ctx.org.id })
        .then((d) => d.organization?.creditBalance ?? null)
        .catch((e) => ({ error: e.message })),
      paged(Q_FLOWS, ctx.hub.id, (d) => d.cmsHub?.contentFlows, 1000),
    ]);
    flows.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    return { ...ctx, balance, flows };
  },

  'GET /api/usage': async (req, url) => {
    const ctx = await resolveHub(url.searchParams.get('hub'));
    const year = Number(url.searchParams.get('year')) || new Date().getFullYear();
    const month = Number(url.searchParams.get('month')) || 0;
    const flow = url.searchParams.get('flow') || '';
    const flowLabel = url.searchParams.get('label') || '';
    const refresh = url.searchParams.get('refresh') === '1';
    let runsError = '';
    const [report, runs] = await Promise.all([
      loadReport(ctx.org.id, year, refresh),
      flow
        ? paged(Q_RUNS, flow, (d) => d.contentFlow?.runs, 2000).catch((e) => {
            runsError = e.message;
            return [];
          })
        : [],
    ]);
    const out = aggregate(report.records, { hub: ctx.hub, flow, flowLabel, year, month, runs });
    out.reportLoadedAt = new Date(report.at).toISOString();
    out.diagnostics.sampleKeys = report.sampleKeys;
    if (out.flow) out.flow.runsError = runsError;
    return out;
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (route) return send(res, 200, await route(req, url));
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.status ?? 500, { error: e.message });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Flow Credit Usage: http://localhost:${PORT} (preselected hub ${HUB_ID})`);
    console.log(token ? 'Personal access token: from AMPLIENCE_PAT.' : 'No AMPLIENCE_PAT set: enter the token in the app.');
  });
}
