import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("异常历史点在悬浮框显示错误内容", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/app.css", import.meta.url), "utf8");

  assert.match(source, /data-message="\$\{escapeHtml\(errorTooltipMessage\(point\)\)\}"/);
  assert.match(source, /class="tooltip-error"/);
  assert.match(source, /statusClass\(point\.status\) === "outage"/);
  assert.match(source, /isLegacyCompletedResponsesFalsePositive/);
  assert.match(source, /上游已返回完整 Responses SSE/);
  assert.match(source, /displayMessage\(item\.message, item\.status\)/);
  assert.match(source, /chartRect\.top - height - 4/);
  assert.match(styles, /\.tooltip-error/);
  assert.match(styles, /overflow-wrap:\s*anywhere/);
});

test("分组汇总使用最严重状态对应的消息", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(source, /filter\(\(point\) => point\.status === status\)/);
  assert.match(source, /return \{ \.\.\.representative, status \}/);
});

test("状态页面显示检测模型名称", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(source, /child-model/);
  assert.match(source, /data-model=/);
  assert.match(source, /tooltip-model/);
  assert.match(source, /item\.model \|\| "模型未知"/);
});

test("生图渠道单独成组并显示检测间隔", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/app.css", import.meta.url), "utf8");

  assert.match(source, /name: "生图"/);
  const start = source.indexOf("const definitions = [");
  const definitions = source.slice(start, source.indexOf("];", start));
  assert.ok(definitions.indexOf('name: "生图"') > definitions.indexOf('name: "GPT"'), "生图分组应排在文本分组之后");
  assert.ok(definitions.indexOf('name: "GPT"') < definitions.indexOf('name: "Claude"'), "GPT 分组应排在 Claude 之前");
  assert.match(source, /const isGrok = \(item\) => \/Grok\|xAI\//);
  assert.match(source, /!isGrok\(item\) && \/GPT\|OpenAI\//);
  assert.match(source, /const isImage = \(item\) => item\.kind === "image"/);
  assert.ok(!/name: "GPT", match: \(item\) => \/GPT/.test(source), "GPT 分组必须排除生图组件");
  assert.match(source, /child-interval/);
  assert.match(source, /intervalLabel/);
  assert.match(source, /basePollIntervalMs/);
  assert.match(styles, /\.child-interval/);
});

test("生图历史条可点击查看最近一张图", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/app.css", import.meta.url), "utf8");

  assert.match(source, /data-image-url/);
  assert.match(source, /openImagePreview/);
  assert.match(source, /image-preview/);
  assert.match(source, /最近一张生图/);
  assert.match(source, /点击条上任意一点查看最近一张生图/);
  assert.match(styles, /\.image-bars/);
  assert.match(styles, /\.image-preview/);
});
