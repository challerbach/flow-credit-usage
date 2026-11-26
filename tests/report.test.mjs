// Unit tests for report parsing and aggregation: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normId, parseReport, normaliseEntry, aggregate } from '../server.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');
const FLOW = 'd1b2c3d4-0000-4000-8000-000000000001';
const HUB = { id: b64('CMSHub:org_x/641a123294efd40001d0f0d1'), dcHubId: '641a123294efd40001d0f0d1' };

const entry = (date, run, items, extra = {}) => ({
  date, requestId: `req-${date}`, source: 'workflow', type: 'debit', change: '-1',
  event: { orgId: 'org_x', payload: { title: 'Flow run', attributes: [
    { key: 'cmsHubId', value: extra.hub ?? 'org_x/641a123294efd40001d0f0d1' },
    { key: 'workflowId', value: extra.flow ?? FLOW },
    { key: 'workflowLabel', value: 'Content Audit' },
    { key: 'workflowRunId', value: run },
    { key: 'workflowRunLabel', value: `Run ${run}` },
  ], lineItems: items.map(([unit, quantity, credits, actionLabel]) => ({ unit, quantity: String(quantity), credits: String(credits), attributes: [{ key: 'actionLabel', value: actionLabel }] })) } },
});

const RAW = [
  entry('2026-11-02T10:00:00Z', 'r1', [['action.trigger', 1, 1, 'Webhook'], ['gpt.input-tokens', 1000, 2.5, 'Agent']]),
  entry('2026-11-02T10:05:00Z', 'r1', [['gpt.output-tokens', 500, 1.5, 'Agent']]),
  entry('2026-11-03T09:00:00Z', 'r2', [['action.cpu.seconds', 3, 0.25, 'Fetch']]),
  entry('2026-10-30T09:00:00Z', 'r0', [['action.trigger', 1, 1, 'Webhook']]),
  entry('2026-11-04T09:00:00Z', 'x1', [['action.trigger', 1, 1, 'Webhook']], { flow: 'other-flow' }),
  entry('2026-11-04T09:00:00Z', 'y1', [['action.trigger', 1, 7, 'Webhook']], { hub: 'org_x/ffffffffffffffffffffffff' }),
  { date: '2026-11-01T00:00:00Z', type: 'credit', change: '1000', event: { payload: { title: 'Top-up', attributes: [] } } },
];

test('normId decodes GraphQL IDs', () => {
  assert.equal(normId(b64(`ContentFlow:${FLOW}`)), FLOW);
  assert.equal(normId(FLOW.toUpperCase()), FLOW);
  assert.equal(normId(HUB.id), 'org_x/641a123294efd40001d0f0d1');
  assert.equal(normId('641a123294efd40001d0f0d1'), '641a123294efd40001d0f0d1');
});

test('parseReport reads arrays, wrapped arrays and JSON lines', () => {
  assert.equal(parseReport(JSON.stringify(RAW)).length, RAW.length);
  assert.equal(parseReport(JSON.stringify({ records: RAW })).length, RAW.length);
  assert.equal(parseReport(RAW.map((r) => JSON.stringify(r)).join('\n')).length, RAW.length);
});

test('aggregate: one flow, one month', () => {
  const records = RAW.map(normaliseEntry);
  const runs = [{ id: b64('ContentFlowRun:r1'), status: 'COMPLETE', createdDate: '2026-11-02T09:59:00Z' }, { id: 'r9', status: 'FAILED', createdDate: '2026-11-05T00:00:00Z' }];
  const out = aggregate(records, { hub: HUB, flow: b64(`ContentFlow:${FLOW}`), year: 2026, month: 11, runs });
  assert.equal(out.flow.total, 5.25);
  assert.equal(out.flow.runs.length, 2);
  assert.equal(out.flow.runs.find((r) => r.id === 'r1').credits, 5);
  assert.equal(out.flow.runs.find((r) => r.id === 'r1').status, 'COMPLETE');
  assert.equal(out.flow.actions[0].action, 'Agent');
  assert.equal(out.flow.actions[0].credits, 4);
  assert.equal(out.flow.runsWithoutCredits, 1);
  assert.deepEqual(out.hubFlows.map((f) => [f.key, f.credits]), [[FLOW, 5.25], ['other-flow', 1]]);
  assert.equal(out.hubTotal, 6.25);
});

test('aggregate: whole year includes October', () => {
  const out = aggregate(RAW.map(normaliseEntry), { hub: HUB, flow: FLOW, year: 2026, month: 0 });
  assert.equal(out.flow.total, 6.25);
  assert.equal(out.flow.days.length, 3);
});

test('runKey matches run IDs in different wrappings', async () => {
  const { runKey } = await import('../server.mjs');
  const id = 'f35c4cdf-d2b0-4360-bb11-37e7e7fb4c5c';
  assert.equal(runKey(id), id);
  assert.equal(runKey(b64(`ContentFlowRun:${id}`)), id);
  assert.equal(runKey(b64(`ContentFlowRun:org_x/641a123294efd40001d0f0d1/${id}`)), id);
  assert.equal(runKey('r1'), 'r1');
});
