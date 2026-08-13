export function booleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function stringEnv(name, fallback, maxLength = 80) {
  const value = process.env[name]?.trim();
  return (value || fallback).slice(0, maxLength);
}
