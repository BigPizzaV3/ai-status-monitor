const componentRoot = document.querySelector("#components");
const incidentsRoot = document.querySelector("#incidents");
const overallDot = document.querySelector("#overallDot");
const overallTitle = document.querySelector("#overallTitle");
const overallMessage = document.querySelector("#overallMessage");
const historyRange = document.querySelector("#historyRange");
const heroStatus = document.querySelector("#heroStatus");
const refreshButton = document.querySelector("#refresh");
const hoverTooltip = document.querySelector("#hoverTooltip");
const homeView = document.querySelector("#homeView");
const historyView = document.querySelector("#historyView");
const historyPageRange = document.querySelector("#historyPageRange");
const historyNavigationButtons = [...document.querySelectorAll("[data-history-direction]")];
const chartBarsCache = new WeakMap();
let activeTooltipTarget = null;
let activeHistoryBar = null;
let activeHistoryPage = 0;
let loading = false;

const isHistoryPage = window.location.pathname === "/history" || window.location.pathname === "/history/";
document.body.classList.toggle("history-page", isHistoryPage);
homeView.hidden = isHistoryPage;
historyView.hidden = !isHistoryPage;

refreshButton.addEventListener("click", () => load(activeHistoryPage));
historyNavigationButtons.forEach((button) => button.addEventListener("click", () => {
  const targetPage = button.dataset.historyDirection === "older"
    ? activeHistoryPage + 1
    : Math.max(0, activeHistoryPage - 1);
  load(targetPage);
}));
componentRoot.addEventListener("click", (event) => {
  const toggle = event.target.closest(".group-toggle");
  if (!toggle) return;
  const row = toggle.closest(".group-row");
  const opening = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", String(opening));
  row.classList.toggle("expanded", opening);
  hideTooltip();
});
componentRoot.addEventListener("pointermove", trackTooltip);
componentRoot.addEventListener("pointerleave", hideTooltip);
componentRoot.addEventListener("focusin", showTooltip);
componentRoot.addEventListener("focusout", hideTooltip);

async function load(historyPage = activeHistoryPage) {
  if (loading) return;
  loading = true;
  refreshButton.disabled = true;
  refreshButton.textContent = "刷新中...";
  historyNavigationButtons.forEach((button) => { button.disabled = true; });
  try {
    const response = await fetch(`/api/status?historyPage=${historyPage}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message || "状态数据暂时不可用");
    activeHistoryPage = data.history?.page ?? historyPage;
    render(data);
  } catch (error) {
    setOverall("outage", "状态数据暂时不可用", error.message);
    if (isHistoryPage) incidentsRoot.innerHTML = `<div class="history-empty">${escapeHtml(error.message)}</div>`;
  } finally {
    loading = false;
    refreshButton.disabled = false;
    refreshButton.textContent = "刷新状态";
  }
}

function render(data) {
  heroStatus.hidden = data.showOverallAlert === false;
  if (data.overall === "outage") {
    setOverall("outage", "部分系统出现异常", "我们已检测到影响部分模型服务的问题。");
  } else if (data.overall === "degraded") {
    setOverall("degraded", "部分系统性能下降", "部分真实模型请求的响应时间高于 10 秒。");
  } else {
    setOverall("operational", "所有系统运行正常", "目前没有发现影响系统的已知问题。");
  }

  const groups = buildGroups(data.components);
  const range = formatHistoryRange(data.components);
  historyRange.textContent = range;
  historyPageRange.textContent = range;
  componentRoot.innerHTML = groups.map((group) => renderGroup(group, data.defaultGroupsExpanded === true)).join("");
  incidentsRoot.innerHTML = renderHistory(data);
  updateHistoryNavigation(data.history);
}

function updateHistoryNavigation(history = {}) {
  for (const button of historyNavigationButtons) {
    button.disabled = button.dataset.historyDirection === "older"
      ? history.hasOlder !== true
      : history.hasNewer !== true;
  }
}

function setOverall(status, title, message) {
  heroStatus.className = `overall-panel ${status}`;
  overallDot.className = `status-icon ${status}`;
  overallDot.textContent = statusGlyph(status);
  overallTitle.textContent = title;
  overallMessage.textContent = message;
}

function buildGroups(components) {
  const definitions = [
    { name: "Claude", match: (item) => /Claude|Anthropic/i.test(`${item.name} ${item.providerType}`) },
    { name: "GPT", match: (item) => /GPT|OpenAI/i.test(`${item.name} ${item.providerType}`) }
  ];
  const used = new Set();
  const groups = definitions.map((definition) => {
    const children = components.filter((item) => definition.match(item));
    children.forEach((item) => used.add(item.id));
    return makeGroup(definition.name, children);
  }).filter((group) => group.children.length);
  const other = components.filter((item) => !used.has(item.id));
  if (other.length) groups.push(makeGroup("其他模型", other));
  return groups;
}

function makeGroup(name, children) {
  const latestStatuses = children.map((item) => item.latest?.status || "unknown");
  const uptimeValues = children.map((item) => Number(item.uptime)).filter(Number.isFinite);
  return {
    name,
    children,
    status: worstStatus(latestStatuses),
    uptime: uptimeValues.length ? trimNumber(uptimeValues.reduce((sum, value) => sum + value, 0) / uptimeValues.length) : null,
    points: aggregatePoints(children)
  };
}

function aggregatePoints(components) {
  const maxLength = Math.max(0, ...components.map((item) => item.points.length));
  return Array.from({ length: maxLength }, (_, index) => {
    const statuses = [];
    let newest = null;
    for (const component of components) {
      const offset = maxLength - component.points.length;
      const point = component.points[index - offset];
      if (!point) continue;
      statuses.push(point.status);
      if (!newest || new Date(point.at) > new Date(newest.at)) newest = point;
    }
    return newest ? { ...newest, status: worstStatus(statuses) } : null;
  }).filter(Boolean);
}

function renderGroup(group, expanded) {
  const status = statusClass(group.status);
  return `<article class="group-row${expanded ? " expanded" : ""}">
    <button class="group-toggle" type="button" aria-expanded="${expanded}">
      <span class="status-icon ${status}" aria-hidden="true">${statusGlyph(group.status)}</span>
      <h3>${escapeHtml(group.name)}</h3>
      <span class="info-icon" data-tooltip="${escapeHtml(`${group.name} 模型服务汇总`)}">i</span>
      <span class="component-count">${group.children.length} 个组件</span>
      <span class="chevron" aria-hidden="true"></span>
      <span class="uptime">${group.uptime === null ? "" : `${group.uptime}% 可用率`}</span>
    </button>
    ${renderBars(group.points)}
    <div class="children-collapse"><div class="children-inner">
      ${group.children.map(renderChild).join("")}
    </div></div>
  </article>`;
}

function renderChild(component) {
  const status = component.latest?.status || "unknown";
  return `<div class="child-row">
    <div class="child-heading">
      <span class="status-icon ${statusClass(status)}" aria-hidden="true">${statusGlyph(status)}</span>
      <h4>${escapeHtml(component.name)}</h4>
      <span class="uptime">${component.uptime === null ? "" : `${trimNumber(component.uptime)}% 可用率`}</span>
    </div>
    ${renderBars(component.points)}
  </div>`;
}

function renderBars(points) {
  const count = 91;
  const sampled = points.length > count
    ? Array.from({ length: count }, (_, index) => points[Math.floor(index * points.length / count)])
    : [...Array(Math.max(0, count - points.length)).fill(null), ...points];
  return `<div class="history-bars" aria-label="最近真实请求记录">${sampled.map((point) => point
    ? `<span class="history-bar ${barClass(point.status)}" tabindex="0" data-date="${escapeHtml(formatDate(point.at))}" data-status="${escapeHtml(statusLabel(point.status))}" data-kind="${statusClass(point.status)}" data-latency="${escapeHtml(formatLatency(point.latencyMs))}"></span>`
    : `<span class="history-bar empty" tabindex="0" data-date="暂无数据" data-status="无检测记录" data-kind="unknown" data-latency="延迟未知"></span>`).join("")}</div>`;
}

function renderHistory(data) {
  if (!data.incidents.length) return `<div class="history-empty"><span class="status-icon">✓</span><strong>暂无当前事件</strong><p>所有受监控服务均在正常运行。</p></div>`;
  const byDay = new Map();
  for (const incident of data.incidents) {
    const date = new Date(incident.at);
    const key = date.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(incident);
  }
  return [...byDay.values()].map((incidents) => {
    const date = new Date(incidents[0].at);
    const day = date.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", day: "2-digit" }).replace("日", "");
    const weekday = date.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).replace("周", "");
    return `<section class="incident-day">
      <div class="incident-date"><strong>${escapeHtml(day)}</strong><span>日</span><span>周${escapeHtml(weekday)}</span></div>
      <div class="day-incidents">${incidents.map(renderIncident).join("")}</div>
    </section>`;
  }).join("");
}

function renderIncident(item) {
  const time = new Date(item.at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
  return `<article class="incident-card ${statusClass(item.status)}">
    <div class="incident-copy"><h2>${escapeHtml(item.componentName)} · ${escapeHtml(statusLabel(item.status))}</h2><p>${escapeHtml(item.message || "检测到服务状态异常。")}</p></div>
    <time datetime="${escapeHtml(item.at)}">${escapeHtml(time)}</time>
  </article>`;
}

function trackTooltip(event) {
  const info = event.target.closest("[data-tooltip]");
  if (info) {
    showTooltipFor(info, event);
    return;
  }

  const chart = event.target.closest(".history-bars");
  if (!chart) {
    hideTooltip();
    return;
  }

  const mobile = window.matchMedia("(max-width: 767px)").matches;
  let cached = chartBarsCache.get(chart);
  if (!cached || cached.mobile !== mobile) {
    const allBars = [...chart.querySelectorAll(".history-bar")];
    cached = { mobile, bars: mobile ? allBars.slice(31) : allBars };
    chartBarsCache.set(chart, cached);
  }
  const bars = cached.bars;
  if (!bars.length) return;
  const chartRect = chart.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - chartRect.left) / chartRect.width));
  const target = bars[Math.min(bars.length - 1, Math.floor(ratio * bars.length))];
  showTooltipFor(target, event, chartRect);
}

function showTooltip(event) {
  const target = event.target.closest("[data-tooltip], .history-bar");
  if (!target || !componentRoot.contains(target)) return;
  showTooltipFor(target, event);
}

function showTooltipFor(target, event, chartRect = null) {
  const isBar = target.classList.contains("history-bar");
  const targetChanged = activeTooltipTarget !== target;
  const tooltipClass = isBar ? "hover-tooltip chart-tooltip visible" : "hover-tooltip info-tooltip visible";
  const tooltipContent = isBar
    ? `<div class="tooltip-date">${escapeHtml(target.dataset.date)}</div><div class="tooltip-result"><span class="status-icon ${escapeHtml(target.dataset.kind)}">${statusGlyph(target.dataset.kind)}</span><strong>${escapeHtml(target.dataset.status)}</strong><span class="tooltip-latency">${escapeHtml(target.dataset.latency)}</span></div>`
    : escapeHtml(target.dataset.tooltip);

  if (targetChanged) {
    hoverTooltip.className = tooltipClass;
    hoverTooltip.innerHTML = tooltipContent;
    activeTooltipTarget = target;
  }
  hoverTooltip.hidden = false;
  hoverTooltip.classList.add("visible");
  if (isBar) {
    if (activeHistoryBar !== target) {
      activeHistoryBar?.classList.remove("active");
      target.classList.add("active");
      activeHistoryBar = target;
    }
    const targetRect = target.getBoundingClientRect();
    const clientX = Number.isFinite(event.clientX) ? event.clientX : targetRect.left + targetRect.width / 2;
    positionChartTooltip(clientX, chartRect || target.closest(".history-bars").getBoundingClientRect());
  } else {
    activeHistoryBar?.classList.remove("active");
    activeHistoryBar = null;
    if (event.type === "focusin") positionTooltipByElement(target);
    else moveTooltip(event);
  }
}

function moveTooltip(event) {
  if (hoverTooltip.hidden || typeof event.clientX !== "number") return;
  const margin = 10;
  const width = hoverTooltip.offsetWidth;
  const height = hoverTooltip.offsetHeight;
  const left = Math.min(window.innerWidth - width - margin, Math.max(margin, event.clientX - width / 2));
  const top = event.clientY - height - 11 > margin ? event.clientY - height - 11 : event.clientY + 14;
  hoverTooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function positionTooltipByElement(target) {
  const rect = target.getBoundingClientRect();
  moveTooltip({ clientX: rect.left + rect.width / 2, clientY: rect.top });
}

function positionChartTooltip(clientX, chartRect) {
  const margin = 10;
  const width = hoverTooltip.offsetWidth;
  const left = Math.min(window.innerWidth - width - margin, Math.max(margin, clientX - width / 2));
  const top = chartRect.bottom + 4;
  hoverTooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function hideTooltip() {
  hoverTooltip.classList.remove("visible");
  hoverTooltip.hidden = true;
  activeTooltipTarget = null;
  activeHistoryBar?.classList.remove("active");
  activeHistoryBar = null;
}

function worstStatus(statuses) {
  const rank = { error: 5, failed: 5, validation_failed: 5, degraded: 4, maintenance: 3, unknown: 2, operational: 1 };
  return statuses.reduce((worst, status) => (rank[status] || 2) > (rank[worst] || 0) ? status : worst, "operational");
}
function statusLabel(status) { return { operational: "正常运行", degraded: "性能下降", failed: "服务中断", validation_failed: "验证失败", error: "服务异常", maintenance: "维护中", unknown: "未知" }[status] || status; }
function statusClass(status) { if (["failed", "validation_failed", "error", "outage"].includes(status)) return "outage"; if (["degraded", "maintenance"].includes(status)) return "degraded"; if (status === "unknown") return "unknown"; return "operational"; }
function statusGlyph(status) { const kind = statusClass(status); return kind === "outage" ? "×" : kind === "degraded" ? "!" : kind === "unknown" ? "?" : "✓"; }
function barClass(status) { return statusClass(status); }
function trimNumber(value) { return Number(Number(value).toFixed(2)); }
function formatLatency(value) {
  const latency = Number(value);
  if (!Number.isFinite(latency) || latency < 0) return "延迟未知";
  return `${Math.round(latency)}ms`;
}
function formatHistoryRange(components) {
  const dates = components.flatMap((item) => item.points.map((point) => new Date(point.at))).filter((date) => !Number.isNaN(date.valueOf())).sort((a, b) => a - b);
  if (!dates.length) return "暂无记录";
  const first = dates[0].toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const last = dates.at(-1).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${first} - ${last}`;
}
function formatDate(value) { return value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "-"; }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

load();
setInterval(load, 120_000);
