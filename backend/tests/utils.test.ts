import test from "node:test";
import assert from "node:assert/strict";
import { reference, idempotencyKey } from "../src/utils.js";

function req(headers: Record<string,string> = {}) { return { headers }; }

test("transaction references are unique-looking and prefixed", () => {
  const a = reference("INT");
  const b = reference("INT");
  assert.match(a, /^INT-/);
  assert.match(b, /^INT-/);
  assert.notEqual(a, b);
});

test("idempotency key reads the request header", () => {
  assert.equal(idempotencyKey(req({"idempotency-key":"abc-123"})), "abc-123");
  assert.equal(idempotencyKey(req()), "");
});
