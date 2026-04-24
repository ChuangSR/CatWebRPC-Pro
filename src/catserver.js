/**
 * catserver.js — WAMP RPC 网关 + 浏览器实例池管理
 *
 * 架构概述：
 *   本服务同时运行两个 HTTP 服务器：
 *     1. 内部服务（INTERNAL_PORT）— 仅供浏览器直连，提供 WAMP 路由、心跳接口、CatWebService.js 文件服务
 *     2. 外部 API（API_PORT）— 供外部调用方使用，提供 /call、/batch、/health、/instances、/kill 接口
 *
 * 核心流程：
 *   外部调用方 → POST /call → catserver → WAMP RPC → 浏览器实例执行签名 → 返回结果
 *
 * 浏览器池机制：
 *   - 每个浏览器实例启动后会定时 POST /browser/ping 上报心跳
 *   - 超过 BROWSER_TTL 无心跳的实例视为离线
 *   - 池内实例不足时自动 spawn 新实例补充
 *   - _pendingCount 追踪已 spawn 但尚未心跳上线的实例数，防止重复补充
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const {spawn} = require('child_process')
const express = require('express')
const FoxRouter = require('fox-wamp')
// Node.js 没有内置 WebSocket 全局，autobahn 依赖它；用 ws 包补全
if (typeof WebSocket === 'undefined') {
    global.WebSocket = require('ws');
}
const autobahn = require('autobahn')
const bodyParser = require('body-parser')

// ─── 从 config.jsonc 加载配置（自动去除 // 注释，跳过字符串内容）───────────
/**
 * 加载 JSONC 文件（带 // 行注释的 JSON）。
 * 逐字符解析，跟踪双引号字符串边界，仅删除字符串外的 // 注释，
 * 避免 https:// 等 URL 被误删。
 */
function loadJsonc(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8')
    let out = '', inStr = false, esc = false
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i]
        if (esc) { out += ch; esc = false; continue }   // 转义字符，原样保留
        if (ch === '\\') { out += ch; esc = true; continue }  // 反斜杠，标记下一字符为转义
        if (ch === '"') { inStr = !inStr; out += ch; continue }  // 双引号切换字符串状态
        if (!inStr && ch === '/' && raw[i + 1] === '/') {  // 字符串外的 // 注释，跳过到行尾
            while (i < raw.length && raw[i] !== '\n') i++
            out += '\n'
            continue
        }
        out += ch
    }
    return JSON.parse(out)
}
const config = loadJsonc(path.join(__dirname, '..', 'config.jsonc'))

// ─── 配置项提取 ────────────────────────────────────────────────────────────────
const INTERNAL_PORT = config.internal.port    // 内部服务端口（WAMP + 心跳 + 静态文件）
const INTERNAL_HOST = config.internal.host    // 内部服务监听地址
const API_PORT = config.api.port              // 外部 API 端口
const API_HOST = config.api.host              // 外部 API 监听地址
const API_AUTH_KEY = config.api.auth_key || ''  // 鉴权密钥，为空则不鉴权
const RPC_TIMEOUT = config.rpc_timeout_ms     // 单次 RPC 调用超时（毫秒）
const POOL_SIZE = config.pool.size            // 浏览器实例池目标数量

/** 返回 ISO 8601 格式的时间戳，用于日志前缀 */
function timestamp() {
    return new Date().toISOString()
}

// ─── 内部服务 app（浏览器直连）──────────────────────────────────────────────
let internalApp = express()
internalApp.use(bodyParser.json())

// Chrome 98+ Private Network Access：HTTPS 页面访问 ws://127.0.0.1 前会发 OPTIONS 预检
// 若服务器不回 Access-Control-Allow-Private-Network: true，浏览器会拦截 WS 消息帧
internalApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    next();
})

// ─── 外部 API app（/call, /batch, /health, /instances, /kill）───────────────
let apiApp = express()
apiApp.use(bodyParser.json())

// CORS + 鉴权中间件
apiApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Key');
    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    // 鉴权：auth_key 非空时校验 header X-Auth-Key 或 query ?key=
    if (API_AUTH_KEY) {
        const key = req.headers['x-auth-key'] || req.query.key || '';
        if (key !== API_AUTH_KEY) {
            res.status(401).json({code: -1, result: '鉴权失败：无效的 auth key'});
            return;
        }
    }
    next();
})

// ─── 启动 launcher.py 实例 ────────────────────────────────────────────
const LAUNCHER_SCRIPT = path.join(__dirname, 'launcher.py');

/**
 * spawnLauncher()
 * 使用项目 .venv 中的 Python 启动一个新的浏览器实例进程。
 * 进程以 detached 模式运行，父进程不等待子进程退出。
 * stdout/stderr 转发到本服务日志，方便排查问题。
 */
// 记录所有 spawn 出来的子进程引用，用于退出时统一清理
const _childProcesses = new Set();

function spawnLauncher() {
    const projectRoot = path.join(__dirname, '..');
    // Windows 和 Linux/macOS 的 Python 路径不同
    const py = process.platform === 'win32'
        ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(projectRoot, '.venv', 'bin', 'python3');
    console.log(`[${timestamp()}] [LAUNCHER] 启动: ${py} ${LAUNCHER_SCRIPT}`);
    const child = spawn(py, ['-u', LAUNCHER_SCRIPT], {
        stdio: ['ignore', 'pipe', 'pipe'],  // stdin 忽略，stdout/stderr 管道捕获
        cwd: projectRoot,       // 与手动运行时保持一致的工作目录
        env: { ...process.env, PYTHONUNBUFFERED: '1' },  // -u 和 PYTHONUNBUFFERED 双重保证 Python 不缓冲输出
    });
    // 记录子进程引用，退出时统一清理
    _childProcesses.add(child);
    // 转发子进程输出到本服务日志
    child.stdout.on('data', d => console.log(`[${timestamp()}] [LAUNCHER] [OUT] ${d.toString().trim()}`));
    child.stderr.on('data', d => console.error(`[${timestamp()}] [LAUNCHER] [ERR] ${d.toString().trim()}`));
    // 子进程退出时扣减 pending 计数，并移除引用
    child.on('exit', (code, signal) => {
        console.warn(`[${timestamp()}] [LAUNCHER] 进程退出 code=${code} signal=${signal}`);
        if (_pendingCount > 0) _pendingCount--;
        _childProcesses.delete(child);
    });
    child.on('error', err => {
        console.error(`[${timestamp()}] [LAUNCHER] 启动失败: ${err.message}`);
        _childProcesses.delete(child);
    });
}

// ─── 浏览器池 ─────────────────────────────────────────────────────────────────
const browserPool = new Map();  // uuid → { lastSeen, pid }
const BROWSER_TTL = config.pool.browser_ttl_ms         // 超过此时间无心跳视为离线
let _reopenTimer = null;                                // 定时补充实例的计时器
let _lastReopenAt = 0;                                  // 上次补充实例的时间戳
const REOPEN_COOLDOWN = config.pool.reopen_cooldown_ms  // 两次补充之间的最短间隔
const SPAWN_INTERVAL = config.pool.spawn_interval_ms    // 多实例启动时每个实例之间的间隔
let _pendingCount = 0  // 已 spawn 但尚未心跳上线的实例数，防止重复补充

/**
 * activeBrowserCount()
 * 统计当前心跳正常的浏览器实例数量。
 * 遍历池中所有实例，lastSeen 在 BROWSER_TTL 内的视为活跃。
 */
function activeBrowserCount() {
    const now = Date.now();
    let n = 0;
    for (const info of browserPool.values()) {
        if (now - info.lastSeen < BROWSER_TTL) n++;
    }
    return n;
}

/**
 * killBrowser(uuid)
 * 终止单个浏览器实例，并从池中移除。
 * Windows 上使用 taskkill /T /F 杀死整个进程树（Python → Chromium），
 * 其他平台使用 process.kill SIGTERM。
 * 返回 true 表示成功终止，false 表示实例不存在或无 PID。
 */
function killBrowser(uuid) {
    const info = browserPool.get(uuid);
    if (!info || !info.pid) return false;
    try {
        if (process.platform === 'win32') {
            // Windows: taskkill /T 杀进程树，/F 强制终止
            spawn('taskkill', ['/PID', String(info.pid), '/T', '/F'], {stdio: 'ignore'});
        } else {
            process.kill(info.pid, 'SIGTERM');
        }
        console.warn(`[${timestamp()}] [POOL] 已终止实例 ${uuid.slice(0, 8)}… (PID ${info.pid})`);
    } catch (e) {
        // 进程可能已自行退出，忽略 ESRCH（No such process）错误
        if (e.code !== 'ESRCH') {
            console.warn(`[${timestamp()}] [POOL] 终止实例失败 (PID ${info.pid}): ${e.message}`);
        }
    }
    browserPool.delete(uuid);
    return true;
}

/**
 * killAllBrowsers()
 * 终止池内所有浏览器实例。用于健康检测连续失败等紧急场景。
 */
function killAllBrowsers() {
    const uuids = [...browserPool.keys()];
    if (uuids.length === 0) return;
    console.warn(`[${timestamp()}] [POOL] 强制终止全部 ${uuids.length} 个实例...`);
    uuids.forEach(killBrowser);
}

/**
 * ensurePool(urgent)
 * 确保浏览器实例池中有足够数量的活跃实例。
 *
 * 逻辑：
 *   1. 计算当前活跃实例 + 待就绪实例与目标数量的差距
 *   2. 差距 <= 0 时无需补充
 *   3. 非紧急模式下遵守 REOPEN_COOLDOWN 冷却时间，防止频繁 spawn
 *   4. 紧急模式且池完全为空时，绕过冷却立即补充
 *   5. 补充时增加 _pendingCount，防止多处理发触发时重复补充
 *
 * @param {boolean} urgent - true 表示紧急补充（池为空时绕过冷却）
 */
function ensurePool(urgent = false) {
    const alive = activeBrowserCount();
    const needed = POOL_SIZE - alive - _pendingCount;  // 扣除待就绪的实例，避免重复 spawn
    if (needed <= 0) return;

    const now = Date.now();
    const bypassCooldown = urgent && alive === 0;  // 池完全为空时紧急绕过冷却
    if (!bypassCooldown && now - _lastReopenAt < REOPEN_COOLDOWN) return;

    _lastReopenAt = now;
    _pendingCount += needed;  // 先占位，心跳到达或进程退出时扣减
    console.warn(`[${timestamp()}] [POOL] 活跃实例 ${alive}/${POOL_SIZE}，待就绪 ${_pendingCount}，补充 ${needed} 个 [urgent=${urgent}]...`);
    for (let i = 0; i < needed; i++) {
        // 每个实例间隔 SPAWN_INTERVAL 启动，避免同时启动导致资源争抢
        setTimeout(() => spawnLauncher(), i * SPAWN_INTERVAL);
    }
}

/** 启动定时监控，每 10 秒检查一次池是否需要补充 */
function startSessionMonitor() {
    if (_reopenTimer) clearInterval(_reopenTimer);
    _reopenTimer = setInterval(() => ensurePool(false), 10_000);
}

// ─── WAMP 连接 ────────────────────────────────────────────────────────────────
// catserver 作为 WAMP 客户端连接到内部服务上的 FoxRouter，
// 通过 session.call() 向浏览器实例发起 RPC 调用。

var connection = new autobahn.Connection({
    url: 'ws://127.0.0.1:' + INTERNAL_PORT + '/rpc',  // 连接本机内部服务的 WAMP 端点
    realm: config.wamp.realm,
    max_retries: config.wamp.max_retries,              // -1 = 无限重试
    retry_delay_growth: config.wamp.retry_delay_growth,
    initial_retry_delay: config.wamp.initial_retry_delay,
    max_retry_delay: config.wamp.max_retry_delay,
});

let session = null;  // WAMP session，连接成功后赋值

/**
 * GetReturnMsg(code, result, instance)
 * 构造统一格式的 API 响应对象。
 *
 * @param {number} code     - 状态码，0=成功，-1=失败
 * @param {*} result        - 成功时为原始结果对象，失败时为错误信息字符串
 * @param {string|null} instance - 执行本次 RPC 的浏览器实例 UUID，失败时不传
 * @returns {{code: number, result: *, instance?: string}}
 */
function GetReturnMsg(code, result, instance = null) {
    const obj = {code: isNaN(parseInt(code)) ? -1 : parseInt(code), result}
    if (instance) obj.instance = instance;
    return obj;
}

/**
 * callWithTimeout(topic, args, argsDict, timeout)
 * 带超时的 WAMP RPC 调用。session.call 本身不支持超时，用 Promise + setTimeout 实现。
 *
 * @param {string} topic      - WAMP RPC topic（如 "com.tiktok.XBogus.abc123"）
 * @param {Array} args        - 位置参数列表
 * @param {Object|null} argsDict - 关键字参数字典（如 {__ua: "..."}）
 * @param {number} timeout    - 超时毫秒数，默认 RPC_TIMEOUT
 */
function callWithTimeout(topic, args, argsDict, timeout = RPC_TIMEOUT) {
    // 兼容旧调用方式：第三个参数直接传数字作为 timeout
    if (typeof argsDict === 'number') {
        timeout = argsDict;
        argsDict = null;
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`RPC call timeout after ${timeout}ms`));
        }, timeout);
        session.call(topic, args, argsDict || undefined).then(result => {
            clearTimeout(timer);
            resolve(result);
        }).catch(err => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

const RETRY_DELAY = 0;  // 失败后立即重试（新实例 20s+ 才就绪，等待无意义）

// ─── POST /call （外部 API）──────────────────────────────────────────────────
/**
 * 单次 RPC 调用接口。
 *
 * 请求格式：
 *   URL:  POST /call?topic=com.xxx.xxx[&ua=...]
 *   Body: 任意 JSON（将作为 args 传给 RPC 函数）
 *          如果需要同时传 UA 和自定义 args，可用 {args: [...], __ua: "..."}
 *
 * 响应格式：
 *   成功: {code: 0, result: <原始结果对象>, instance: "<uuid>"}
 *   失败: {code: -1, result: "<错误信息>"}
 *
 * 流程：
 *   1. 从浏览器池中随机选一个活跃实例
 *   2. 用 topic.uuid 调用该实例的 RPC
 *   3. 失败时自动触发 ensurePool 补充，并立即重试一次（换一个实例）
 */
apiApp.post('/call', async (req, res) => {
    try {
        // 参数校验
        if (!req.query.topic) {
            return res.send(GetReturnMsg(-1, "url query topic 不存在"));
        }
        if (!session) {
            return res.send(GetReturnMsg(-1, "500 服务器未初始化成功"));
        }
        if (activeBrowserCount() === 0) {
            ensurePool(true);
            return res.send(GetReturnMsg(-1, "500 浏览器池为空，已触发自动重启"));
        }

        const topic = `${req.query.topic}`;
        // 随机选择一个活跃实例，用 topic.uuid 定向调用
        const uuid = randomActiveUUID();
        if (!uuid) {
            ensurePool(true);
            return res.send(GetReturnMsg(-1, "500 浏览器池为空，已触发自动重启"));
        }
        const fullTopic = topic + '.' + uuid;

        // UA 动态注入：支持 query ?ua= 或 body.__ua 传入自定义 User-Agent
        // 签名函数执行期间 CatWebService.js 会临时替换 navigator.userAgent
        let argsList = req.body;
        let argsDict = null;
        const customUA = req.query.ua
            || (!Array.isArray(req.body) && typeof req.body === 'object' && req.body.__ua);
        if (customUA) {
            // 如果 body 是对象且包含 args 字段，提取 args 作为位置参数
            if (!Array.isArray(req.body) && typeof req.body === 'object' && req.body.args) {
                argsList = req.body.args;
            }
            argsDict = {__ua: customUA};
            console.log(`[${timestamp()}] [RPC] ${topic} [UA: ${customUA.slice(0, 60)}...] instance=${uuid.slice(0, 8)}…`);
        } else {
            console.log(`[${timestamp()}] [RPC] ${topic} instance=${uuid.slice(0, 8)}…`);
        }

        let r;
        try {
            // 首次调用
            r = await callWithTimeout(fullTopic, argsList, argsDict);
        } catch (e) {
            // 首次失败：触发补充 + 立即重试
            console.warn(`[${timestamp()}] [RPC] 首次失败 (${e.message || e.error})，触发 ensurePool 并立即重试...`);
            ensurePool(true);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            if (!session) return res.send(GetReturnMsg(-1, "重试时 session 仍未就绪"));
            // 重试时重新选一个实例
            const retryUuid = randomActiveUUID();
            if (!retryUuid) return res.send(GetReturnMsg(-1, "重试时浏览器池为空"));
            r = await callWithTimeout(topic + '.' + retryUuid, argsList, argsDict);
            res.send(GetReturnMsg(0, r, retryUuid));
            return;
        }
        res.send(GetReturnMsg(0, r, uuid));
    } catch (e) {
        console.error(`[${timestamp()}] [RPC] error: ${e.message || e.error}`);
        res.send(GetReturnMsg(-1, `${e.message || e.error}`));
    }
})

/**
 * randomActiveUUID()
 * 从活跃浏览器池中随机抽取一个实例的 UUID。
 * 用于 /call 和 /batch 接口的负载均衡。
 *
 * @returns {string|null} 活跃实例的 UUID，无活跃实例时返回 null
 */
function randomActiveUUID() {
    const now = Date.now();
    const active = [...browserPool.entries()]
        .filter(([, info]) => now - info.lastSeen < BROWSER_TTL)
        .map(([uuid]) => uuid);
    if (active.length === 0) return null;
    return active[Math.floor(Math.random() * active.length)];
}

// ─── POST /batch （外部 API）─────────────────────────────────────────────────
/**
 * 批量 RPC 调用接口。在同一个浏览器实例上并行执行多个 RPC 任务。
 *
 * 请求格式（两种）：
 *   1. 纯数组: [{topic: "...", args: [...]}, ...]
 *   2. 对象体: {__ua: "...", tasks: [{topic: "...", args: [...]}, ...]}
 *
 * 响应格式：
 *   数组，每项: {code: 0|−1, result: <结果对象或错误信息>, instance: "<uuid>"}
 */
apiApp.post('/batch', async (req, res) => {
    try {
        // 解析请求体，兼容两种格式
        let tasks, argsDict = null;
        if (Array.isArray(req.body)) {
            tasks = req.body;
        } else if (req.body && Array.isArray(req.body.tasks)) {
            tasks = req.body.tasks;
            if (req.body.__ua) argsDict = {__ua: req.body.__ua};
        } else {
            return res.send(GetReturnMsg(-1, "body 必须是非空数组 [{topic, args}] 或 {__ua, tasks:[...]}"));
        }
        if (tasks.length === 0) {
            return res.send(GetReturnMsg(-1, "tasks 不能为空"));
        }
        if (!session) return res.send(GetReturnMsg(-1, "500 服务器未初始化成功"));

        // 选择一个活跃实例执行所有任务（保证同一实例上下文一致）
        const uuid = randomActiveUUID();
        if (!uuid) {
            ensurePool(true);
            return res.send(GetReturnMsg(-1, "500 浏览器池为空，已触发自动重启"));
        }
        console.log(`[${timestamp()}] [BATCH] 实例 ${uuid.slice(0, 8)}… 处理 ${tasks.length} 个任务${argsDict ? ' [UA]' : ''}`);

        // 并行执行所有任务，每个任务用 topic.uuid 定向调用
        const results = await Promise.all(tasks.map(task =>
            callWithTimeout(task.topic + '.' + uuid, task.args, argsDict)
                .then(r => ({code: 0, result: r, instance: uuid}))
                .catch(e => ({code: -1, result: e.message || e.error, instance: uuid}))
        ));
        res.send(results);
    } catch (e) {
        console.error(`[${timestamp()}] [RPC batch] error: ${e.message || e}`);
        res.send(GetReturnMsg(-1, e.message || e));
    }
})

// ─── GET /health （外部 API）─────────────────────────────────────────────────
/**
 * 健康检查接口，返回服务状态概览。
 *
 * 响应格式：
 *   {session: bool, browsers: number, pool: number, ts: number}
 */
apiApp.get('/health', (req, res) => {
    res.json({session: session !== null, browsers: activeBrowserCount(), pool: POOL_SIZE, ts: Date.now()})
})

// ─── GET /instances （外部 API）— 获取实例列表 ──────────────────────────────
/**
 * 获取浏览器实例列表及状态详情。
 *
 * 响应格式：
 *   {
 *     total: number,      // 池中总实例数
 *     active: number,     // 心跳正常的实例数
 *     pool: number,       // 目标池大小
 *     instances: [{       // 每个实例的详情
 *       uuid: string,
 *       pid: number|null,
 *       lastSeen: number, // 最后心跳时间戳
 *       alive: boolean    // 是否心跳正常
 *     }]
 *   }
 */
apiApp.get('/instances', (req, res) => {
    const now = Date.now();
    const list = [...browserPool.entries()].map(([uuid, info]) => ({
        uuid,
        pid: info.pid || null,
        lastSeen: info.lastSeen,
        alive: now - info.lastSeen < BROWSER_TTL,
    }));
    res.json({total: list.length, active: list.filter(i => i.alive).length, pool: POOL_SIZE, instances: list});
})

// ─── POST /kill （外部 API）— 终止指定实例 ──────────────────────────────────
/**
 * 终止指定 UUID 的浏览器实例。
 * 终止后自动触发 ensurePool 补充新实例。
 *
 * 请求格式：
 *   {uuid: "完整实例UUID"}
 *
 * 响应格式：
 *   成功: {code: 0, result: "实例 xxx… 已终止并移除", instance: "uuid"}
 *   失败: {code: -1, result: "错误信息"}
 */
apiApp.post('/kill', (req, res) => {
    const {uuid} = req.body || {};
    if (!uuid) {
        return res.send(GetReturnMsg(-1, "body 需要 uuid 字段"));
    }
    const info = browserPool.get(uuid);
    if (!info) {
        return res.send(GetReturnMsg(-1, `实例 ${uuid} 不在池中`));
    }
    const killed = killBrowser(uuid);
    console.log(`[${timestamp()}] [KILL] 实例 ${uuid.slice(0, 8)}… 已清理 (killed=${killed})`);
    res.send(GetReturnMsg(0, `实例 ${uuid.slice(0, 8)}… 已终止并移除`, uuid));
    setTimeout(() => ensurePool(true), 500);  // 延迟 500ms 后补充新实例
})

// ─── 浏览器心跳 （内部服务）──────────────────────────────────────────────────
/**
 * POST /browser/ping
 * 浏览器实例定期上报心跳，维持在线状态。
 * CatWebService.js 每 30 秒调用一次。
 *
 * 请求格式：{uuid: string, pid: number}
 *
 * 首次心跳时从 _pendingCount 扣减（实例已就绪）。
 */
internalApp.post('/browser/ping', (req, res) => {
    const {uuid, pid} = req.body || {};
    if (!uuid) return res.json({ok: false});
    const existing = browserPool.get(uuid) || {};
    // 首次心跳：从 pending 计数中扣减（表示实例已成功启动并连接）
    if (!existing.lastSeen && _pendingCount > 0) _pendingCount--;
    browserPool.set(uuid, {lastSeen: Date.now(), pid: pid || existing.pid});
    console.log(`[${timestamp()}] [POOL] ping  ${uuid.slice(0, 8)}… pid=${pid || existing.pid} active=${activeBrowserCount()}/${POOL_SIZE} pending=${_pendingCount}`);
    res.json({ok: true, active: activeBrowserCount()});
})

/**
 * POST /browser/bye
 * 浏览器实例关闭前主动通知服务端，从池中移除并触发补充。
 * 使用 navigator.sendBeacon 发送，保证页面关闭时也能送达。
 *
 * 请求格式：{uuid: string}
 */
internalApp.post('/browser/bye', (req, res) => {
    const {uuid} = req.body || {};
    if (uuid) browserPool.delete(uuid);
    const alive = activeBrowserCount();
    console.log(`[${timestamp()}] [POOL] bye   ${(uuid || '').slice(0, 8)}… active=${alive}/${POOL_SIZE}`);
    res.json({ok: true, active: alive});
    setTimeout(() => ensurePool(true), 500);  // 延迟 500ms 后补充新实例
})

// ─── GET /catservice.js （内部服务）──────────────────────────────────────────
/**
 * 提供 CatWebService.js 文件服务。
 * 浏览器可通过此接口获取 RPC 框架脚本（当前实际通过 data: URL 注入，此接口备用）。
 */
internalApp.get('/catservice.js', (req, res) => {
    const abs = path.join(__dirname, 'CatWebService.js');
    fs.readFile(abs, 'utf-8', (err, data) => {
        if (err) {
            res.status(404).send('// Not found: CatWebService.js');
            return;
        }
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.send(data);
    });
})

// ─── HTTP Server 创建与启动 ──────────────────────────────────────────────────
let internalServer = http.createServer(internalApp)  // 内部服务：WAMP + 心跳 + 静态文件
let apiServer = http.createServer(apiApp)             // 外部 API：/call, /batch, /health 等

// TCP keepalive 防止 NAT 静默断开长连接（WAMP WebSocket 连接可能长时间无流量）
internalServer.on('connection', socket => socket.setKeepAlive(true, 30000))

// ─── WAMP Session 管理 ────────────────────────────────────────────────────────
/**
 * startWampSession()
 * 建立 catserver → FoxRouter 的 WAMP 连接。
 * 连接成功后 session 可用于向浏览器实例发起 RPC 调用。
 * 连接断开时 session 置 null，autobahn 自动重连。
 */
function startWampSession() {
    connection.onopen = newSession => {
        session = newSession;
        console.log(`[${timestamp()}] [WAMP] session established`);
    };
    connection.onclose = (reason, details) => {
        console.error(`[${timestamp()}] [WAMP] closed: ${reason}`, details);
        session = null;
        return false;  // 返回 false = autobahn 自动重连
    };
    connection.open();
}

// FoxRouter 作为 WAMP Dealer，挂载到内部服务的 /rpc 路径
// 浏览器实例通过 ws://localhost:INTERNAL_PORT/rpc 连接
router = new FoxRouter()
router.listenWAMP({server: internalServer, path: '/rpc'})

// 启动内部服务，同时初始化 WAMP 连接和实例池监控
internalServer.listen(INTERNAL_PORT, INTERNAL_HOST, () => {
    startWampSession();      // 建立 WAMP 连接
    startSessionMonitor();   // 启动定时池补充检查
    console.log(`[${timestamp()}] 内部服务就绪: http://${INTERNAL_HOST}:${INTERNAL_PORT}/ (WAMP + 浏览器心跳)`);
    // 启动初始浏览器实例，每个间隔 SPAWN_INTERVAL
    console.log(`[${timestamp()}] [POOL] 启动 ${POOL_SIZE} 个 launcher.py 实例...`);
    for (let i = 0; i < POOL_SIZE; i++) {
        setTimeout(() => spawnLauncher(), i * SPAWN_INTERVAL);
    }
})

// 启动外部 API 服务
apiServer.listen(API_PORT, API_HOST, () => {
    console.log(`[${timestamp()}] 外部 API 就绪: http://${API_HOST}:${API_PORT}/call`);
})

// ─── 优雅退出：Ctrl+C 时清理所有浏览器子进程 ─────────────────────────────────
let _shuttingDown = false;

function gracefulShutdown(signal) {
    if (_shuttingDown) return;  // 防止重复触发
    _shuttingDown = true;
    console.log(`\n[${timestamp()}] 收到 ${signal}，正在清理浏览器实例...`);

    // 终止池内所有浏览器实例（会 kill Python 进程及其 Chromium 子进程）
    killAllBrowsers();

    // 兜底：直接 kill 所有 spawn 出来的子进程引用
    for (const child of _childProcesses) {
        try { child.kill(); } catch {}
    }
    _childProcesses.clear();

    // 关闭 HTTP 服务器，停止接受新连接
    internalServer.close();
    apiServer.close();

    // 断开 WAMP 连接
    if (session) {
        try { connection.close(); } catch {}
        session = null;
    }

    console.log(`[${timestamp()}] 清理完成，退出。`);
    process.exit(0);
}

// SIGINT: Ctrl+C
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// SIGTERM: kill 命令、Docker 停止等
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
