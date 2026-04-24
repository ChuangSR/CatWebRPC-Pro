# Web-RPC

通过浏览器实例池提供 WAMP RPC 服务，将浏览器端的函数暴露为 HTTP API，供外部程序调用。

## 架构

```
外部调用方
    │
    ▼ HTTP API (10068)
┌──────────┐
│ catserver │ ← Node.js 网关
│           │
│  ┌──────┐ │
│  │ Fox  │ │ ← WAMP Router
│  │Router│ │
│  └──┬───┘ │
└─────┼─────┘
      │ WAMP (10067)
      │
  ┌───┴───┐  ┌───┴───┐  ┌───┴───┐
  │Browser│  │Browser│  │Browser│   ← 浏览器实例池
  │  #1   │  │  #2   │  │  #3   │
  └───────┘  └───────┘  └───────┘
```

- **catserver.js** — Node.js 网关，管理浏览器实例池，提供外部 HTTP API，通过 WAMP 转发 RPC 调用到浏览器
- **launcher.py** — Python 启动器，用 Playwright (Patchright) 启动浏览器，注入 CSP 移除和 RPC 框架脚本
- **CatWebService.js** — 浏览器端 RPC 框架，连接 WAMP 路由，自动注册 SDK 函数
- **sdk.js** — SDK（本地替换版本）
- **config.jsonc** — 统一配置文件

## 快速开始

### 环境要求

- Node.js >= 18
- Python >= 3.8
- Microsoft Edge / Chrome / Chromium 已安装

### 安装

```bash
# 克隆项目
git clone <repo-url>
cd web-rpc

# 安装 Node.js 依赖
npm install

# 创建 Python 虚拟环境并安装依赖
python -m venv .venv

# Windows
.venv\Scripts\pip install -r requirements.txt

# Linux/macOS
.venv/bin/pip install -r requirements.txt
```

> **关于浏览器下载**：当前配置使用 `channel: "msedge"`，Patchright 会直接调用系统已安装的 Edge 浏览器，**无需额外下载**。如果改为不指定 `channel`（使用 Patchright 自带的 Chromium），则需要先执行：
>
> ```bash
> # Windows
> .venv\Scripts\patchright install chromium
>
> # Linux/macOS
> .venv/bin/patchright install chromium
> ```

### 启动

```bash
node src/catserver.js
```

启动后日志输出：

```
[2026-04-24T10:00:00.000Z] 内部服务就绪: http://0.0.0.0:10067/ (WAMP + 浏览器心跳)
[2026-04-24T10:00:00.000Z] [POOL] 启动 1 个 launcher.py 实例...
[2026-04-24T10:00:00.000Z] 外部 API 就绪: http://0.0.0.0:10068/call
```

按 `Ctrl+C` 优雅退出，所有浏览器实例会自动清理。

## 配置

所有配置在 `config.jsonc` 中，支持 `//` 行注释。

### 内部服务

```jsonc
"internal": {
    "port": 10067,       // WAMP 路由 + 浏览器心跳端口
    "host": "0.0.0.0"   // 监听地址
}
```

### 外部 API

```jsonc
"api": {
    "port": 10068,       // 外部 API 端口
    "host": "0.0.0.0",  // "0.0.0.0" 允许外部访问，"127.0.0.1" 仅本机
    "auth_key": ""       // 鉴权密钥，为空不鉴权
}
```

启用鉴权后，调用 API 需通过 `X-Auth-Key` header 或 `?key=` query 传入密钥。

### 浏览器实例池

```jsonc
"pool": {
    "size": 1,                  // 同时维护的浏览器实例数量
    "browser_ttl_ms": 45000,    // 无心跳超时（毫秒）
    "reopen_cooldown_ms": 60000, // 补充实例的最短间隔
    "spawn_interval_ms": 60000   // 多实例启动间隔
}
```

### 浏览器启动参数

```jsonc
"browser": {
    "channel": "msedge",      // Chromium 通道：msedge / chrome / chromium
    "headless": false,        // true = 无头模式
    "window_size": "1280,800",
    "args": [...]             // Chromium 命令行参数
}
```

### 代理

```jsonc
"proxy": {
    "enabled": true,                       // 是否启用
    "server": "http://127.0.0.1:10808"    // 代理地址
}
```

### CSP 处理与脚本注入

```jsonc
"csp": {
    "patterns": [                        // URL 匹配模式，只有匹配的请求才移除 CSP 并注入脚本
        "https://www.example.com/**"     // 支持通配符：* 匹配除 / 外的字符，** 匹配任意字符含 /
    ],                                   // 为空则匹配所有请求
    "resource_types": ["document"],      // 需要处理的资源类型，常见值：document / stylesheet / script / image 等；为空则处理所有类型
    "main_frame_only": true              // true = 仅处理主框架请求，false = 子框架（iframe）也会处理
}
```

### 请求拦截替换

```jsonc
"intercepts": [
    {
        "pattern": "**/*sdk*",                              // Playwright 路由匹配模式
        "file": "sdk.js",                                  // src/ 下的本地文件
        "content_type": "application/javascript; charset=utf-8"
    }
]
```

可以添加多条拦截规则，将远程请求替换为本地文件。

### RPC 注册

```jsonc
"rpc": {
    "sdk_window_prop": "sdk",    // window 上 SDK 对象的属性名
    "topics": [
        {
            "topic": "com.example.sign",   // WAMP topic
            "method": "sign",              // SDK 上的方法名
            "concurrency": 30,             // 并发数
            "invoke": "first"              // 调用策略：first / roundrobin / random
        }
    ]
}
```

要支持不同平台，只需修改 `sdk_window_prop` 和 `topics`，无需改动代码。

## API 接口

所有接口默认在 `http://localhost:10068` 上提供。启用鉴权时需传 `X-Auth-Key` header 或 `?key=` 参数。

### POST /call — 单次 RPC 调用

```bash
# 基本调用
curl -X POST "http://localhost:10068/call?topic=com.example.sign" \
  -H "Content-Type: application/json" \
  -d '["arg1", "arg2"]'

# 带 UA 注入
curl -X POST "http://localhost:10068/call?topic=com.example.sign&ua=Mozilla/5.0..." \
  -H "Content-Type: application/json" \
  -d '{"args": ["arg1"], "__ua": "Mozilla/5.0..."}'

# 带鉴权
curl -X POST "http://localhost:10068/call?topic=com.example.sign" \
  -H "X-Auth-Key: your-secret" \
  -H "Content-Type: application/json" \
  -d '["arg1"]'
```

响应：

```json
// 成功
{"code": 0, "result": {"signed": "..."}, "instance": "a1b2c3d4..."}

// 失败
{"code": -1, "result": "RPC call timeout after 10000ms"}
```

- `code`: 0=成功，-1=失败
- `result`: 成功时为浏览器端 JS 函数的返回值（直接透传），失败时为错误信息字符串
- `instance`: 执行本次调用的浏览器实例 UUID

### POST /batch — 批量 RPC 调用

```bash
# 纯数组格式
curl -X POST http://localhost:10068/batch \
  -H "Content-Type: application/json" \
  -d '[{"topic":"com.example.sign","args":["url1"]},{"topic":"com.example.encrypt","args":["url2"]}]'

# 带 UA 的对象格式
curl -X POST http://localhost:10068/batch \
  -H "Content-Type: application/json" \
  -d '{"__ua":"Mozilla/5.0...","tasks":[{"topic":"com.example.sign","args":["url1"]}]}'
```

响应：

```json
[
    {"code": 0, "result": {"signed": "..."}, "instance": "a1b2c3d4..."},
    {"code": -1, "result": "RPC call timeout after 10000ms", "instance": "a1b2c3d4..."}
]
```

每项含 `code`、`result`（成功为 JS 函数返回值，失败为字符串）、`instance`，格式与 `/call` 一致。

### GET /health — 健康检查

```bash
curl http://localhost:10068/health
```

响应：

```json
{"session": true, "browsers": 2, "pool": 3, "ts": 1713945600000}
```

### GET /instances — 实例列表

```bash
curl http://localhost:10068/instances
```

响应：

```json
{
    "total": 2,
    "active": 2,
    "pool": 3,
    "instances": [
        {"uuid": "a1b2c3d4...", "pid": 12345, "lastSeen": 1713945600000, "alive": true}
    ]
}
```

### POST /kill — 终止指定实例

```bash
curl -X POST http://localhost:10068/kill \
  -H "Content-Type: application/json" \
  -d '{"uuid": "a1b2c3d4..."}'
```

终止后自动补充新实例。

## 工作原理

1. **catserver.js** 启动时，根据 `pool.size` 配置 spawn 对应数量的 **launcher.py** 进程
2. 每个 **launcher.py** 用 Patchright (Playwright) 启动一个浏览器，打开目标页面
3. 页面加载时，launcher 拦截 HTML 响应，移除 CSP 头并注入 **CatWebService.js**
4. 拦截匹配 `intercepts` 配置的请求，替换为本地文件
5. **CatWebService.js** 在浏览器中连接 WAMP 路由，按 `rpc.topics` 配置自动注册函数
6. 浏览器实例每 30 秒上报心跳到 `/browser/ping`
7. 外部调用 `/call` 时，catserver 随机选一个活跃实例，通过 WAMP 调用对应函数
8. 失败时自动重试一次并触发实例补充

## 项目结构

```
web-rpc/
├── config.jsonc           # 统一配置文件（带注释的 JSON）
├── package.json           # Node.js 依赖
├── requirements.txt       # Python 依赖
├── src/
│   ├── catserver.js       # Node.js 网关（WAMP + HTTP API + 实例池）
│   ├── launcher.py        # Python 浏览器启动器（Playwright）
│   ├── CatWebService.js   # 浏览器端 RPC 框架（Wampy + Proxy 拦截）
│   └── sdk.js        # SDK（本地替换版本）
└── .venv/                 # Python 虚拟环境
```
