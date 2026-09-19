import assert from "node:assert/strict";
import test from "node:test";

const { digestAction, canonicalise } = await import(
  "../utils/action-digest.js"
);

const BASE = {
  sessionId: "sess-1",
  method: "DELETE",
  path: "/api/v1/board-members/clx-1",
  body: { reason: "left the board" },
};

test("the same request digests the same way twice", () => {
  assert.equal(digestAction(BASE), digestAction({ ...BASE }));
});

test("key order does not change the digest", () => {
  const a = digestAction({
    ...BASE,
    body: { alpha: 1, beta: { x: 1, y: 2 }, gamma: [3, 4] },
  });
  const b = digestAction({
    ...BASE,
    body: { gamma: [3, 4], beta: { y: 2, x: 1 }, alpha: 1 },
  });

  assert.equal(
    a,
    b,
    "otherwise the flow would fail at random, depending on how a client's JSON library ordered its keys",
  );
});

test("array order does change it, because a reordered list is a different list", () => {
  assert.notEqual(
    digestAction({ ...BASE, body: { trustees: ["a", "b"] } }),
    digestAction({ ...BASE, body: { trustees: ["b", "a"] } }),
  );
});

test("a changed value changes the digest", () => {
  assert.notEqual(
    digestAction(BASE),
    digestAction({ ...BASE, body: { reason: "something else entirely" } }),
  );
});

test("approving one record does not approve another", () => {
  assert.notEqual(
    digestAction(BASE),
    digestAction({ ...BASE, path: "/api/v1/board-members/clx-2" }),
    "this is the whole point of binding the approval to the request",
  );
});

test("approving a read does not approve a delete", () => {
  assert.notEqual(
    digestAction(BASE),
    digestAction({ ...BASE, method: "PATCH" }),
  );
});

test("one session's approval is useless to another", () => {
  assert.notEqual(
    digestAction(BASE),
    digestAction({ ...BASE, sessionId: "sess-2" }),
  );
});

test("the method is compared without regard to case", () => {
  assert.equal(
    digestAction(BASE),
    digestAction({ ...BASE, method: "delete" }),
  );
});

test("an absent body and an empty body are the same request", () => {
  const empty = digestAction({ ...BASE, body: {} });
  assert.equal(digestAction({ ...BASE, body: undefined }), empty);
  assert.equal(digestAction({ ...BASE, body: null }), empty);
});

test("an explicitly undefined field is the same as an absent one", () => {
  assert.equal(
    digestAction({ ...BASE, body: { reason: "x" } }),
    digestAction({ ...BASE, body: { reason: "x", note: undefined } }),
    "JSON has no undefined; the digest must not depend on how the body was built",
  );
});

test("the query string is not part of the action", () => {
  assert.equal(
    digestAction(BASE),
    digestAction({ ...BASE, path: `${BASE.path}?page=2` }),
  );
});

test("the digest is a hex sha-256 and carries none of the request in the clear", () => {
  const digest = digestAction(BASE);

  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.ok(!digest.includes("clx-1"));
  assert.ok(!digest.includes("sess-1"));
});

test("canonicalise leaves primitives and dates in a comparable form", () => {
  assert.equal(canonicalise(3), 3);
  assert.equal(canonicalise("x"), "x");
  assert.equal(canonicalise(null), null);
  assert.equal(
    canonicalise(new Date("2026-01-01T00:00:00.000Z")),
    "2026-01-01T00:00:00.000Z",
    "two equal dates built differently must not digest differently",
  );
});

test("nested objects are canonicalised too, not just the top level", () => {
  assert.equal(
    JSON.stringify(canonicalise({ b: { d: 1, c: 2 }, a: 3 })),
    JSON.stringify({ a: 3, b: { c: 2, d: 1 } }),
  );
});
