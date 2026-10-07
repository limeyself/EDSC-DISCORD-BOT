import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  evaluateCountingMessage,
  expectedNumber,
  initialCountingState,
  isCountingState,
  parseCountMessage,
  resetCounting,
  type CountingState,
} from "./counting.ts";

const state = (count: number, record: number): CountingState => ({ count, record });

describe("parseCountMessage", () => {
  test("accepts bare numbers, trimmed and with leading zeros", () => {
    assert.equal(parseCountMessage("5"), 5);
    assert.equal(parseCountMessage("  42  "), 42);
    assert.equal(parseCountMessage("007"), 7);
    assert.equal(parseCountMessage("0"), 0);
  });

  test("rejects chat, decimals, negatives and grouped numbers", () => {
    assert.equal(parseCountMessage(""), null);
    assert.equal(parseCountMessage("   "), null);
    assert.equal(parseCountMessage("meet at 3"), null);
    assert.equal(parseCountMessage("5.5"), null);
    assert.equal(parseCountMessage("-3"), null);
    assert.equal(parseCountMessage("1,000"), null);
    assert.equal(parseCountMessage("3x"), null);
  });

  test("rejects digit runs that are not safe integers", () => {
    assert.equal(parseCountMessage("9".repeat(16)), null);
  });
});

describe("expectedNumber", () => {
  test("is one past the current count, starting at 1", () => {
    assert.equal(expectedNumber(initialCountingState()), 1);
    assert.equal(expectedNumber(state(41, 100)), 42);
  });
});

describe("resetCounting", () => {
  test("clears the count but keeps the record", () => {
    assert.deepEqual(resetCounting(state(41, 100)), { count: 0, record: 100 });
    assert.deepEqual(resetCounting(state(0, 0)), { count: 0, record: 0 });
  });
});

describe("evaluateCountingMessage", () => {
  test("ignores bots entirely", () => {
    const outcome = evaluateCountingMessage(initialCountingState(), {
      content: "1",
      authorIsBot: true,
    });
    assert.equal(outcome.kind, "ignore");
  });

  test("ignores ordinary chat in the channel", () => {
    const outcome = evaluateCountingMessage(state(4, 10), {
      content: "nice one everyone",
      authorIsBot: false,
    });
    assert.equal(outcome.kind, "ignore");
  });

  test("accepts the first number and advances the count", () => {
    const outcome = evaluateCountingMessage(initialCountingState(), {
      content: "1",
      authorIsBot: false,
    });
    assert.deepEqual(outcome, {
      kind: "correct",
      value: 1,
      next: { count: 1, record: 1 },
    });
  });

  test("advances in order and raises the record when beaten", () => {
    const outcome = evaluateCountingMessage(state(9, 9), {
      content: "10",
      authorIsBot: false,
    });
    assert.deepEqual(outcome, {
      kind: "correct",
      value: 10,
      next: { count: 10, record: 10 },
    });
  });

  test("a correct number below the record never lowers the record", () => {
    const outcome = evaluateCountingMessage(state(5, 50), {
      content: "6",
      authorIsBot: false,
    });
    assert.equal(outcome.kind, "correct");
    if (outcome.kind === "correct") {
      assert.deepEqual(outcome.next, { count: 6, record: 50 });
    }
  });

  test("a skipped number resets the count but reports what was due", () => {
    const outcome = evaluateCountingMessage(state(41, 100), {
      content: "43",
      authorIsBot: false,
    });
    assert.deepEqual(outcome, {
      kind: "wrong",
      value: 43,
      expected: 42,
      next: { count: 0, record: 100 },
    });
  });

  test("posting zero at the start is still wrong", () => {
    const outcome = evaluateCountingMessage(initialCountingState(), {
      content: "0",
      authorIsBot: false,
    });
    assert.equal(outcome.kind, "wrong");
    if (outcome.kind === "wrong") {
      assert.equal(outcome.expected, 1);
      assert.deepEqual(outcome.next, { count: 0, record: 0 });
    }
  });

  test("a wrong number preserves the record for the next run", () => {
    const wrong = evaluateCountingMessage(state(41, 100), {
      content: "7",
      authorIsBot: false,
    });
    assert.equal(wrong.kind, "wrong");
    if (wrong.kind === "wrong") {
      // After the reset the channel can beat the record all over again.
      const next = evaluateCountingMessage(wrong.next, { content: "1", authorIsBot: false });
      assert.equal(next.kind, "correct");
      if (next.kind === "correct") assert.equal(next.next.record, 100);
    }
  });
});

describe("isCountingState", () => {
  test("accepts a well-formed state", () => {
    assert.equal(isCountingState({ count: 0, record: 0 }), true);
    assert.equal(isCountingState({ count: 42, record: 100 }), true);
  });

  test("rejects corrupt or partial values from Redis", () => {
    assert.equal(isCountingState(null), false);
    assert.equal(isCountingState("whenever"), false);
    assert.equal(isCountingState({}), false);
    assert.equal(isCountingState({ count: "3", record: 100 }), false);
    assert.equal(isCountingState({ count: -1, record: 100 }), false);
    assert.equal(isCountingState({ count: 3.5, record: 100 }), false);
    assert.equal(isCountingState({ count: 3 }), false);
  });
});
