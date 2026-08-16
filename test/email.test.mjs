import test from "node:test";
import assert from "node:assert/strict";
import { createEmailNotifier, parseRecipients } from "../src/email.mjs";

test("parseRecipients accepts comma, semicolon, and whitespace separators", () => {
  assert.deepEqual(parseRecipients("a@example.com, b@example.com; c@example.com\nd@example.com"), [
    "a@example.com",
    "b@example.com",
    "c@example.com",
    "d@example.com"
  ]);
});

test("email notifier configures QQ-style TLS on port 465 without exposing secrets", async () => {
  let options;
  let message;
  const notifier = createEmailNotifier({
    host: "smtp.example.com",
    port: 465,
    username: "sender@example.com",
    password: "secret",
    from: "sender@example.com",
    fromName: "Status Monitor",
    useTls: true,
    recipients: "owner@example.com,ops@example.com",
    transportFactory: (value) => {
      options = value;
      return { sendMail: async (mail) => { message = mail; } };
    }
  });

  assert.equal(notifier.enabled, true);
  await notifier.send({ subject: "subject", text: "body" });
  assert.equal(options.secure, true);
  assert.equal(options.requireTLS, false);
  assert.deepEqual(message.to, ["owner@example.com", "ops@example.com"]);
  assert.deepEqual(message.from, { name: "Status Monitor", address: "sender@example.com" });
});

test("email notifier stays disabled when SMTP credentials are incomplete", () => {
  const notifier = createEmailNotifier({ host: "smtp.example.com", recipients: "owner@example.com" });
  assert.equal(notifier.enabled, false);
  assert.match(notifier.reason, /SMTP_USERNAME/);
  assert.match(notifier.reason, /SMTP_PASSWORD/);
});
