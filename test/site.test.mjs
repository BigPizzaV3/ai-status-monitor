import test from "node:test";
import assert from "node:assert/strict";
import { renderSiteHtml } from "../src/site.mjs";

test("site template renders configurable branding and escapes HTML", () => {
  const template = "<title>{{SITE_TITLE}}</title><b>{{SITE_BRAND}}</b><i>{{SITE_FOOTER_BRAND}}</i>";
  const output = renderSiteHtml(template, {
    title: "Status <One>",
    brand: 'A & "B"',
    footerBrand: "Footer's"
  });
  assert.equal(
    output,
    "<title>Status &lt;One&gt;</title><b>A &amp; &quot;B&quot;</b><i>Footer&#39;s</i>"
  );
});
