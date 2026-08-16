import nodemailer from "nodemailer";

export function parseRecipients(value) {
  return String(value || "")
    .split(/[;,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createEmailNotifier({
  host,
  port = 465,
  username,
  password,
  from,
  fromName,
  useTls = true,
  recipients,
  transportFactory = nodemailer.createTransport
} = {}) {
  const to = parseRecipients(recipients);
  const missing = [
    ["SMTP_HOST", host],
    ["SMTP_USERNAME", username],
    ["SMTP_PASSWORD", password],
    ["SMTP_FROM", from],
    ["ALERT_EMAIL_TO", to.length ? "configured" : ""]
  ].filter(([, value]) => !String(value || "").trim()).map(([name]) => name);

  if (missing.length) {
    return {
      enabled: false,
      reason: `邮件告警未启用，缺少配置: ${missing.join(", ")}`,
      async send() { return false; }
    };
  }

  const smtpPort = Number(port) || 465;
  const transport = transportFactory({
    host,
    port: smtpPort,
    secure: Boolean(useTls) && smtpPort === 465,
    requireTLS: Boolean(useTls) && smtpPort !== 465,
    auth: { user: username, pass: password }
  });
  const sender = fromName ? { name: fromName, address: from } : from;

  return {
    enabled: true,
    async send({ subject, text }) {
      await transport.sendMail({ from: sender, to, subject, text });
      return true;
    }
  };
}
