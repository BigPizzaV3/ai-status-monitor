import { stringEnv } from "./env.mjs";

export function loadSiteConfig() {
  return {
    title: stringEnv("SITE_TITLE", "AI Status Monitor"),
    brand: stringEnv("SITE_BRAND", "AI Status Monitor"),
    footerBrand: stringEnv("SITE_FOOTER_BRAND", "AI Status Monitor")
  };
}

export function renderSiteHtml(template, site) {
  return template
    .replaceAll("{{SITE_TITLE}}", escapeHtml(site.title))
    .replaceAll("{{SITE_BRAND}}", escapeHtml(site.brand))
    .replaceAll("{{SITE_FOOTER_BRAND}}", escapeHtml(site.footerBrand));
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}
