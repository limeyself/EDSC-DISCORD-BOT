import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decideReviewRequest,
  decideServerRequest,
  type PendingReview,
  type ReviewRequestInput,
  type ServerRequest,
} from "./review.ts";

const pendingFor = (userId: string): PendingReview => ({
  userId,
  userTag: `${userId}#0001`,
  email: "student@schools.vic.edu.au",
  className: "7A",
  guildId: "111222333444555666",
  requestedAt: "2026-10-07T00:00:00.000Z",
});

const clear: ReviewRequestInput = {
  currentUserId: "100",
  pending: null,
  record: null,
  slotHolder: null,
  classServerGuildId: "999888777666555444",
  botInClassServer: true,
};

describe("decideReviewRequest", () => {
  test("every gate open → create (review can be requested)", () => {
    assert.deepEqual(decideReviewRequest(clear), { action: "create" });
  });

  test("an existing pending request blocks a second one", () => {
    const decision = decideReviewRequest({ ...clear, pending: pendingFor("100") });
    assert.deepEqual(decision, {
      action: "reject",
      reason: "already_pending",
    });
  });

  test("an email claimed by someone else → taken", () => {
    const decision = decideReviewRequest({ ...clear, record: { userId: "999" } });
    assert.deepEqual(decision, { action: "reject", reason: "taken" });
  });

  test("an email claimed by this student → reverify (no review needed)", () => {
    const decision = decideReviewRequest({ ...clear, record: { userId: "100" } });
    assert.equal(decision.action, "reverify");
  });

  test("an occupied class slot blocks the request", () => {
    const decision = decideReviewRequest({ ...clear, slotHolder: "200" });
    assert.deepEqual(decision, { action: "reject", reason: "slot_taken" });
  });

  test("a class with no registered server blocks the request", () => {
    const decision = decideReviewRequest({ ...clear, classServerGuildId: null });
    assert.deepEqual(decision, { action: "reject", reason: "server_missing" });
  });

  test("the bot must be invited to the class server first", () => {
    const decision = decideReviewRequest({ ...clear, botInClassServer: false });
    assert.deepEqual(decision, { action: "reject", reason: "bot_missing" });
  });

  test("pending beats every other reason", () => {
    const decision = decideReviewRequest({
      ...clear,
      pending: pendingFor("100"),
      record: { userId: "999" },
      slotHolder: "200",
      classServerGuildId: null,
      botInClassServer: false,
    });
    assert.deepEqual(decision, {
      action: "reject",
      reason: "already_pending",
    });
  });

  test("an already-approved student is never blocked by setup state", () => {
    const decision = decideReviewRequest({
      ...clear,
      record: { userId: "100" },
      slotHolder: "200",
      classServerGuildId: null,
      botInClassServer: false,
    });
    assert.equal(decision.action, "reverify");
  });

  test("a held slot beats missing setup state (order is deterministic)", () => {
    const decision = decideReviewRequest({
      ...clear,
      slotHolder: "200",
      classServerGuildId: null,
    });
    assert.deepEqual(decision, { action: "reject", reason: "slot_taken" });
  });
});

describe("decideServerRequest", () => {
  const serverRequest = (): ServerRequest => ({
    userId: "100",
    userTag: "student#0001",
    className: "7B",
    serverId: "999888777666555444",
    invite: null,
    guildId: "111222333444555666",
    requestedAt: "2026-10-07T00:00:00.000Z",
  });

  const input = {
    currentUserId: "100",
    ownRequest: null as ServerRequest | null,
    existingGuildId: null as string | null,
    className: "7B",
  };

  test("everything clear → create", () => {
    assert.deepEqual(decideServerRequest(input), { action: "create" });
  });

  test("a student can't have two open server requests", () => {
    const decision = decideServerRequest({ ...input, ownRequest: serverRequest() });
    assert.deepEqual(decision, { action: "duplicate" });
  });

  test("a class that already has a server can't get another one", () => {
    const decision = decideServerRequest({
      ...input,
      existingGuildId: "555444333222111000",
    });
    assert.deepEqual(decision, {
      action: "reject",
      reason: "already_bound",
    });
  });

  test("the same class check drives both the request and its rejection", () => {
    // The modal derives the class from the roster email, so the request and
    // its target class are always the student's own — mirrored here.
    const bound = decideServerRequest({
      ...input,
      className: "7B",
      existingGuildId: "1",
    });
    assert.equal(bound.action, "reject");
    const free = decideServerRequest({ ...input, className: "7B" });
    assert.equal(free.action, "create");
  });
});
