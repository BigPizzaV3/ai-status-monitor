import test from "node:test";
import assert from "node:assert/strict";
import { createNotifierGroup } from "../src/notifier.mjs";

test("notifier group sends through every enabled channel", async () => {
  const sent = [];
  const group = createNotifierGroup([
    { name: "email", notifier: { enabled: true, send: async (message) => sent.push(["email", message]) } },
    { name: "Telegram", notifier: { enabled: true, send: async (message) => sent.push(["Telegram", message]) } },
    { name: "disabled", notifier: { enabled: false, send: async () => sent.push(["disabled"]) } }
  ]);
  const message = { subject: "subject", text: "text" };

  assert.equal(group.enabled, true);
  await group.send(message);
  assert.deepEqual(sent, [["email", message], ["Telegram", message]]);
});

test("notifier group succeeds when at least one channel delivers", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const group = createNotifierGroup([
      { name: "email", notifier: { enabled: true, send: async () => true } },
      { name: "Telegram", notifier: { enabled: true, send: async () => { throw new Error("failed"); } } }
    ]);
    await group.send({ subject: "subject", text: "text" });
  } finally {
    console.error = originalError;
  }
});

test("notifier group fails when every configured channel fails", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const group = createNotifierGroup([
      { name: "Telegram", notifier: { enabled: true, send: async () => { throw new Error("failed"); } } }
    ]);
    await assert.rejects(group.send({ subject: "subject", text: "text" }), /all configured notification channels failed/);
  } finally {
    console.error = originalError;
  }
});
