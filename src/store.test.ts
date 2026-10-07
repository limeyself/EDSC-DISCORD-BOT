import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classServerKey,
  classSlotKey,
  countingChannelKey,
  countingStateKey,
  decideVerification,
  emailKey,
  pendingKey,
  userKey,
  type VerifyRecord,
} from "./store.ts";

const record = (userId: string): VerifyRecord => ({
  userId,
  userTag: `${userId}#0001`,
  email: "zabbi@schools.vic.edu.au",
  className: "7J",
  verifiedAt: "2026-10-06T00:00:00.000Z",
});

describe("decideVerification", () => {
  test("an unclaimed email is free", () => {
    assert.equal(decideVerification(null, "111"), "free");
    assert.equal(decideVerification(undefined, "111"), "free");
  });

  test("the same user re-verifying is allowed", () => {
    assert.equal(decideVerification(record("111"), "111"), "reverify");
  });

  test("another user's claim is taken (manual review)", () => {
    assert.equal(decideVerification(record("111"), "222"), "taken");
  });
});

describe("redis key namespacing", () => {
  test("keys are namespaced under classbot:verify", () => {
    assert.equal(
      emailKey("zabbi@schools.vic.edu.au"),
      "classbot:verify:email:zabbi@schools.vic.edu.au",
    );
    assert.equal(userKey("1234567890"), "classbot:verify:user:1234567890");
  });

  test("email and user key spaces cannot collide", () => {
    const email = emailKey("x");
    const user = userKey("x");
    assert.notEqual(email, user);
    assert.ok(email.startsWith("classbot:verify:email:"));
    assert.ok(user.startsWith("classbot:verify:user:"));
  });
});

describe("counting key namespacing", () => {
  test("counting keys are namespaced under classbot:counting", () => {
    assert.equal(
      countingChannelKey("111"),
      "classbot:counting:channel:111",
    );
    assert.equal(countingStateKey("111"), "classbot:counting:state:111");
  });

  test("channel and state key spaces cannot collide", () => {
    assert.notEqual(countingChannelKey("g"), countingStateKey("g"));
    // …and cannot collide with the verification registry either.
    assert.ok(!countingChannelKey("g").startsWith("classbot:verify:"));
  });
});

describe("review key namespacing", () => {
  test("pending, slot and class-server keys are namespaced and distinct", () => {
    assert.equal(pendingKey("111"), "classbot:verify:pending:111");
    assert.equal(classSlotKey("7A"), "classbot:verify:slot:7A");
    assert.equal(classServerKey("7A"), "classbot:classserver:7A");
    assert.notEqual(classSlotKey("7A"), classServerKey("7A"));
    // The pending key space can't collide with email claims either.
    assert.notEqual(pendingKey("x"), emailKey("x"));
  });
});

describe("verify record", () => {
  test("round-trips through JSON as stored in Redis", () => {
    const stored = record("111");
    const parsed = JSON.parse(JSON.stringify(stored)) as VerifyRecord;
    assert.deepStrictEqual(parsed, stored);
    assert.equal(decideVerification(parsed, "222"), "taken");
  });
});
