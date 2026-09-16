/**
 * Endpoint-level regression test for the cost routes:
 *   GET /model-garden/cost
 *   GET /model-garden/cost-history
 *
 * Why this exists: the DSH session facade no longer exposes a public `events`
 * array. Its log is private and read through `snapshotEvents()` (complete
 * canonical history) or `ownEvents()` (after a fork-inherited prefix). A host
 * half that still reads `session.events` aggregates an EMPTY log — zero steps —
 * and the picker then hides its cost line together with the hover breakdown
 * (`currentCost()` returns null while `totalSteps === 0`).
 *
 * Runs the REAL exported apply() with a mocked cordis ctx plus one fake session
 * per facade generation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../index.js";

const USAGE_EVENTS = [
  { type: "request/context", seq: 1, time: 1000, data: { provider: "p1", model: "m1" } },
  { type: "assistant/message", seq: 2, time: 2000, data: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 } } },
  { type: "assistant/message", seq: 3, time: 3000, data: { usage: { inputTokens: 300, outputTokens: 40 } } },
];

/** Current facade: private log behind snapshotEvents() / ownEvents(). */
function modernSession(events) {
  return {
    snapshotEvents: () => events,
    ownEvents: () => events.slice(1),
  };
}

/** Legacy facade: public events array (pre-snapshot DSH builds). */
function legacySession(events) {
  return { events };
}

/** Unreadable log: the accessor throws (e.g. a detached session). */
function brokenSession() {
  return { snapshotEvents() { throw new Error("detached"); } };
}

/** Build a mock cordis ctx with the webServer route table + a session store. */
function makeCtx(sessionById) {
  const routes = new Map();
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
  const sessions = { get: (id) => sessionById[id] };
  const ctx = {
    get: (name) => ({ webServer, sessions })[name],
    effect: (fn) => fn(),
    on: () => {},
  };
  return { ctx, routes };
}

function responseSpy() {
  let status = 0;
  const body = { text: "" };
  const res = {
    get status() { return status; },
    get body() { return body.text; },
    writeHead(s) { status = s; },
    end(text) { body.text = text; },
  };
  return res;
}

function request(handler, url) {
  const res = responseSpy();
  handler({ method: "GET", url }, res);
  return { status: res.status, body: JSON.parse(res.body) };
}

test("cost-history reads the private log through snapshotEvents()", () => {
  const { ctx, routes } = makeCtx({ s1: modernSession(USAGE_EVENTS) });
  apply(ctx);
  const handler = routes.get("/model-garden/cost-history");
  assert.ok(handler, "cost-history route registered");
  const { status, body } = request(handler, "/model-garden/cost-history?session=s1&limit=200");
  assert.equal(status, 200);
  assert.equal(body.totalSteps, 2, "usage steps must survive the facade change");
  assert.equal(body.models.length, 1);
  assert.equal(body.models[0].model, "m1", "steps are attributed to the request/context model");
  assert.equal(body.models[0].inputTokens, 400);
  assert.equal(body.steps[0].outputTokens, 40, "newest step first");
});

test("cost aggregates the same log instead of returning zeros", () => {
  const { ctx, routes } = makeCtx({ s1: modernSession(USAGE_EVENTS) });
  apply(ctx);
  const { status, body } = request(routes.get("/model-garden/cost"), "/model-garden/cost?session=s1");
  assert.equal(status, 200);
  assert.equal(body.steps, 2);
  assert.equal(body.inputTokens, 400);
  assert.equal(body.outputTokens, 60);
  assert.equal(body.cacheReadTokens, 5);
});

test("a legacy public events array keeps working", () => {
  const { ctx, routes } = makeCtx({ s1: legacySession(USAGE_EVENTS) });
  apply(ctx);
  const { status, body } = request(routes.get("/model-garden/cost"), "/model-garden/cost?session=s1");
  assert.equal(status, 200);
  assert.equal(body.steps, 2);
});

test("an unreadable facade degrades to zeros instead of throwing", () => {
  const { ctx, routes } = makeCtx({ s1: brokenSession() });
  apply(ctx);
  const { status, body } = request(routes.get("/model-garden/cost-history"), "/model-garden/cost-history?session=s1");
  assert.equal(status, 200);
  assert.equal(body.totalSteps, 0);
});

test("cost routes answer 400 without a session and 404 for an unknown one", () => {
  const { ctx, routes } = makeCtx({ s1: modernSession(USAGE_EVENTS) });
  apply(ctx);
  assert.equal(request(routes.get("/model-garden/cost"), "/model-garden/cost").status, 400);
  assert.equal(request(routes.get("/model-garden/cost-history"), "/model-garden/cost-history?session=nope").status, 404);
});
