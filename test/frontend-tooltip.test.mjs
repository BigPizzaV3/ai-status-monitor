import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("异常历史点在悬浮框显示错误内容", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/app.css", import.meta.url), "utf8");

  assert.match(source, /data-message="\$\{escapeHtml\(errorTooltipMessage\(point\)\)\}"/);
  assert.match(source, /class="tooltip-error"/);
  assert.match(source, /statusClass\(point\.status\) === "outage"/);
  assert.match(source, /chartRect\.top - height - 4/);
  assert.match(styles, /\.tooltip-error/);
  assert.match(styles, /overflow-wrap:\s*anywhere/);
});

test("分组汇总使用最严重状态对应的消息", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(source, /filter\(\(point\) => point\.status === status\)/);
  assert.match(source, /return \{ \.\.\.representative, status \}/);
});
