# AI Status Monitor

一个轻量、可自托管的 AI 模型接口状态监控服务。

项目会定时向配置的模型渠道发送真实请求，记录请求状态、响应耗时、端点网络延迟和历史记录，并提供一个可直接由 Nginx 代理的状态页面。

## 功能

- 支持 OpenAI、Anthropic 和 Gemini 协议渠道。
- 支持流式模型请求和真实回复验证。
- 支持随机问答检测，避免仅返回固定内容的假响应。
- 支持简单文本检测，例如只发送 `hi`。
- 支持请求超时、重试和并发控制。
- 支持端点 `HEAD/GET` 网络延迟检测。
- 支持本地 JSON 历史记录，默认保留 30 天。
- 提供状态首页、事件记录页和 JSON API。
- 不依赖数据库、Supabase 或管理后台。
- 可通过环境变量配置站点标题、品牌和页面显示方式。

## 快速部署

需要安装 Docker 和 Docker Compose。

```bash
cp .env.example .env
mkdir -p config data
cp config/providers.example.json config/providers.json
```

编辑 `config/providers.json`，填入实际渠道配置，然后启动：

```bash
docker compose up -d --build
```

服务默认只监听本机端口 `8099`：

```text
http://127.0.0.1:8099
```

推荐通过 Nginx 或其他反向代理对外提供访问，不建议直接暴露检测服务端口。

## 渠道配置

示例配置位于 `config/providers.example.json`。真实配置文件为 `config/providers.json`，该文件包含 API key，不应提交到 Git 仓库。

基本配置示例：

```json
{
  "id": "example-openai",
  "name": "GPT Example",
  "type": "openai",
  "endpoint": "https://example.com/v1/responses",
  "model": "gpt-example",
  "apiKey": "replace-me",
  "checkMode": "challenge",
  "simplePrompt": "hi",
  "enabled": true,
  "isMaintenance": false,
  "requestHeaders": null,
  "metadata": null,
  "groupName": null
}
```

### 问答检测

```json
"checkMode": "challenge"
```

发送随机生成的分类或阅读理解问题，并验证模型返回的答案。未填写 `checkMode` 时默认使用此模式。

### 简单文本检测

```json
"checkMode": "simple",
"simplePrompt": "hi"
```

发送 `simplePrompt`，只要模型返回非空内容即可通过检测。`simplePrompt` 未填写时默认发送 `hi`。

## 环境变量

### 检测参数

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CHECK_POLL_INTERVAL_SECONDS` | `120` | 检测间隔，单位为秒 |
| `CHECK_CONCURRENCY` | `5` | 同时检测的渠道数量 |
| `CHECK_TIMEOUT_MS` | `45000` | 单次请求超时时间 |
| `DEGRADED_THRESHOLD_MS` | `10000` | 超过该耗时标记为性能下降 |
| `HISTORY_RETENTION_DAYS` | `30` | 历史记录保留天数 |
| `API_HISTORY_POINTS` | `91` | API 返回的历史点数量 |

### 页面显示

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SHOW_OVERALL_ALERT` | `false` | 是否显示首页整体异常提示框 |
| `DEFAULT_GROUPS_EXPANDED` | `true` | 页面加载时是否默认展开所有分组 |
| `SITE_TITLE` | `AI Status Monitor` | 浏览器标题 |
| `SITE_BRAND` | `AI Status Monitor` | 页头和面包屑品牌 |
| `SITE_FOOTER_BRAND` | `AI Status Monitor` | 页脚品牌 |

例如：

```dotenv
SITE_TITLE=My AI Status
SITE_BRAND=My AI Status
SITE_FOOTER_BRAND=My AI Status
SHOW_OVERALL_ALERT=false
DEFAULT_GROUPS_EXPANDED=true
```

页面品牌只通过环境变量配置，不需要修改源代码。`.env` 已被 Git 忽略，不应提交到公开仓库。

## API 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 状态首页 |
| `GET` | `/history` | 历史事件页面 |
| `GET` | `/health` | 服务健康检查 |
| `GET` | `/api/status` | 前端使用的状态数据 |
| `GET` | `/api/v1/status` | 原始检测结果，便于其他页面或系统集成 |

## 数据和安全

- `config/providers.json` 包含 API key，必须限制文件权限。
- `data/history.json` 保存检测历史，不应公开访问。
- Docker Compose 已将配置目录只读挂载到容器。
- 建议将 `.env`、`config/providers.json` 和 `data/` 保持在 Git 忽略范围内。
- 项目日志不会输出 API key 或完整请求内容。

## 开发和测试

安装依赖：

```bash
npm install
```

运行测试：

```bash
npm test
```

项目包含配置解析、挑战生成、请求模式、重试逻辑、历史存储、状态转换和页面配置测试。

## 开源许可

本项目采用 MIT License。检测协议适配逻辑参考了 MIT 许可项目 `BingZi-233/check-cx`，相关版权和许可信息见 `LICENSE`。
