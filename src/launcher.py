"""
launcher.py — 用 Playwright 打开浏览器并注入 WAMP RPC 框架

整体流程：
  1. 从 config.jsonc 加载所有配置
  2. 启动 Chromium（反检测参数 + 禁用 Web 安全限制）
  3. 拦截 HTML 文档 → 移除 CSP + 注入 window.__catConfig + CatWebService.js 到 <head>
  4. 根据 config.intercepts 配置，拦截指定请求并替换为本地文件
  5. 打开目标页面
  6. CatWebService.js 在主世界执行，自动连接 WAMP 并按配置注册 RPC
"""

import asyncio
import json
import pathlib
import sys

# Windows 控制台默认编码可能不是 UTF-8，主动重置以避免中文日志乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from patchright.async_api import async_playwright


# ─── 从 config.jsonc 加载配置（去除 // 注释，跳过字符串内容）────────────────────
def _load_jsonc(p):
    """
    加载 JSONC 文件（带 // 行注释的 JSON）。
    逐字符解析，跟踪双引号字符串边界，仅删除字符串外的 // 注释，
    避免 https:// 等 URL 被误删。
    """
    with open(p, encoding="utf-8") as f:
        raw = f.read()
    out, in_str, esc = [], False, False
    i, n = 0, len(raw)
    while i < n:
        ch = raw[i]
        if esc:
            # 上一字符是反斜杠，当前字符是转义内容，原样保留
            out.append(ch); esc = False; i += 1; continue
        if ch == '\\':
            # 遇到反斜杠，标记下一字符为转义
            out.append(ch); esc = True; i += 1; continue
        if ch == '"':
            # 双引号切换字符串状态
            in_str = not in_str; out.append(ch); i += 1; continue
        if not in_str and ch == '/' and i + 1 < n and raw[i + 1] == '/':
            # 字符串外的 // 注释，跳过直到行尾
            while i < n and raw[i] != '\n':
                i += 1
            out.append('\n')
            continue
        out.append(ch); i += 1
    return json.loads(''.join(out))


# ─── 加载配置文件 ─────────────────────────────────────────────────────────────
_CONFIG_PATH = pathlib.Path(__file__).resolve().parent.parent / "config.jsonc"
_config = _load_jsonc(_CONFIG_PATH)

# ─── 页面配置 ─────────────────────────────────────────────────────────────────
PAGE_URL = _config["page"]["url"]                     # 目标页面 URL
GOTO_TIMEOUT = _config["page"]["goto_timeout_ms"]    # 页面加载超时（毫秒）
RPC_WAIT_TIMEOUT = _config["page"]["rpc_wait_timeout_ms"]  # 等待 RPC 注册完成超时（毫秒）

# ─── 代理配置 ─────────────────────────────────────────────────────────────────
USE_PROXY = _config["proxy"]["enabled"]    # 是否启用代理
PROXY_SERVER = _config["proxy"]["server"]  # 代理服务器地址

# ─── CSP 处理范围 ──────────────────────────────────────────────────────────────
_CSP_CONFIG = _config.get("csp", {})
_CSP_PATTERNS = _CSP_CONFIG.get("patterns", [])           # URL 匹配模式，空则匹配所有
_CSP_RESOURCE_TYPES = set(_CSP_CONFIG.get("resource_types", ["document"]))  # 资源类型过滤，空则不过滤
_CSP_MAIN_FRAME_ONLY = _CSP_CONFIG.get("main_frame_only", True)  # 是否仅处理主框架


def _match_url_pattern(url, pattern):
    """
    简单的 URL 通配符匹配。
    *  匹配除 / 外的任意字符
    ** 匹配任意字符（含 /）
    """
    import re
    # 将通配符模式转为正则：** → .*，* → [^/]*，其余转义
    regex = ""
    i = 0
    while i < len(pattern):
        if pattern[i:i+2] == "**":
            regex += ".*"
            i += 2
        elif pattern[i] == "*":
            regex += "[^/]*"
            i += 1
        else:
            regex += re.escape(pattern[i])
            i += 1
    return re.fullmatch(regex, url) is not None


def _should_process_csp(url):
    """判断 URL 是否在 CSP 处理范围内。patterns 为空时处理所有请求。"""
    if not _CSP_PATTERNS:
        return True
    return any(_match_url_pattern(url, p) for p in _CSP_PATTERNS)

# ─── 浏览器启动参数 ────────────────────────────────────────────────────────────
BROWSER_CHANNEL = _config["browser"]["channel"]        # Chromium 通道：msedge / chrome / chromium
BROWSER_HEADLESS = _config["browser"]["headless"]      # 是否无头模式
BROWSER_WINDOW_SIZE = _config["browser"]["window_size"]  # 窗口大小，如 "1280,800"
BROWSER_ARGS = _config["browser"]["args"]               # Chromium 启动参数列表

# ─── 本地资源路径 ──────────────────────────────────────────────────────────────
COOKIE_PATH = pathlib.Path(__file__).parent / "cookie.json"
CATSERVICE_PATH = pathlib.Path(__file__).parent / "CatWebService.js"

# ─── 拦截替换配置 ──────────────────────────────────────────────────────────────
# 根据 config.intercepts 预加载所有本地文件内容到内存，
# 运行时直接用预加载的字节响应，避免每次请求都读磁盘。
_INTERCEPT_RULES = []
for _rule in _config.get("intercepts", []):
    _local_file = pathlib.Path(__file__).parent / _rule["file"]
    if _local_file.is_file():
        _INTERCEPT_RULES.append({
            "pattern": _rule["pattern"],             # Playwright route 匹配模式，如 "**/*webmssdk*"
            "content": _local_file.read_bytes(),      # 本地文件的字节内容
            "content_type": _rule.get("content_type", "application/javascript; charset=utf-8"),
        })
    else:
        print(f"[launcher] 警告: 拦截替换文件不存在: {_local_file}")

# ─── 浏览器端 RPC 配置（注入到 window.__catConfig）────────────────────────────
# 这段 JSON 会被注入为 <script>window.__catConfig=...</script>，
# CatWebService.js 从 window.__catConfig 读取端口、realm、SDK 属性名、topic 列表等，
# 避免在 JS 中硬编码任何业务参数。
_BROWSER_CONFIG = json.dumps({
    "rpcPort": _config["internal"]["port"],          # WAMP 服务端口
    "rpcRealm": _config["wamp"]["realm"],             # WAMP realm 名称
    "sdkWindowProp": _config["rpc"]["sdk_window_prop"],  # window 上 SDK 对象的属性名
    "topics": _config["rpc"]["topics"],               # RPC topic 列表
}, ensure_ascii=False)

# ─── CSP 注入路由常量 ──────────────────────────────────────────────────────────
# 需要从响应头中移除的 CSP 相关 header，浏览器就不会阻止内联脚本和跨域请求
CSP_HEADERS = frozenset([
    "content-security-policy",
    "content-security-policy-report-only",
])
# 除了 CSP，还需移除影响 body 长度/编码的头，否则替换内容后浏览器解析会出错
STRIP_HEADERS = CSP_HEADERS | {"content-encoding", "content-length", "transfer-encoding"}
# 路由拦截时可以忽略的网络错误（连接重置、请求中止等，属于正常断线场景）
_SUPPRESSED_ERRORS = ("socket hang up", "ECONNRESET", "ERR_ABORTED", "Request context disposed")


def make_strip_csp_handler(page, inject_script):
    """
    返回一个 route handler，用于：
      1. 移除响应中的 CSP 头，允许页面执行注入的脚本
      2. 将 inject_script 插入到 HTML <head> 标签后面

    根据 config.csp 配置过滤：resource_types、main_frame_only、patterns
    """

    async def handler(route, request):
        url = request.url

        # 资源类型过滤：只处理配置中指定的类型，为空则不过滤
        if _CSP_RESOURCE_TYPES and request.resource_type not in _CSP_RESOURCE_TYPES:
            await route.continue_()
            return
        # 主框架过滤：main_frame_only=true 时忽略子框架
        if _CSP_MAIN_FRAME_ONLY and request.frame != page.main_frame:
            await route.continue_()
            return
        # 非 HTTP(S) 协议的请求（如 data:、chrome-extension:）直接放行
        if not url.startswith("http://") and not url.startswith("https://"):
            await route.continue_()
            return
        # URL 不在 CSP 处理范围内，直接放行（不移除 CSP，不注入脚本）
        if not _should_process_csp(url):
            await route.continue_()
            return
        try:
            # 向原始服务器发起请求，获取真实响应
            response = await route.fetch()
            raw_headers = response.headers
            body = await response.body()

            # 在 <head> 标签后插入注入脚本
            html = body.decode("utf-8", errors="replace")
            head_pos = html.lower().find("<head")
            if head_pos != -1:
                close_pos = html.find(">", head_pos)
                if close_pos != -1:
                    html = html[:close_pos + 1] + inject_script + html[close_pos + 1:]
                    print(f"[inject] CatWebService.js 已注入到 HTML: {url[:80]}")

            # 移除 CSP 和影响 body 长度的 header，用修改后的 HTML 响应
            headers = {k: v for k, v in raw_headers.items() if k.lower() not in STRIP_HEADERS}
            await route.fulfill(
                status=response.status,
                headers=headers,
                body=html.encode("utf-8"),
            )
        except Exception as e:
            # 只打印非预期错误，连接重置等常见断线错误静默忽略
            if not any(k in str(e) for k in _SUPPRESSED_ERRORS):
                print(f"[inject] 路由异常（继续）: {e}")
            try:
                await route.continue_()
            except Exception:
                pass

    return handler


def make_intercept_handler(local_content, content_type):
    """
    返回一个 route handler，将匹配的请求替换为本地文件内容。
    用于替换远程 JS SDK 为本地修改版本，例如将 sdk.js 替换为本地文件。

    参数:
        local_content: 本地文件的字节内容
        content_type:  响应的 Content-Type，如 "application/javascript; charset=utf-8"
    """

    async def handler(route, request):
        url = request.url
        print(f"[intercept] 替换为本地文件 ({len(local_content)} bytes): {url[:70]}")
        await route.fulfill(
            status=200,
            content_type=content_type,
            body=local_content,
        )

    return handler


async def launch():
    """启动浏览器、注册路由拦截、打开目标页面、等待 RPC 就绪，然后保持运行。"""

    # 读取 CatWebService.js 内容，后续编码为 data: URL 注入到页面
    catservice_content = CATSERVICE_PATH.read_text(encoding="utf-8")

    async with async_playwright() as pw:
        # ── 代理配置 ────────────────────────────────────────────────────────
        proxy_config = {"server": PROXY_SERVER} if USE_PROXY else None
        if USE_PROXY:
            print(f"[launcher] 浏览器代理: {PROXY_SERVER}")

        # ── 启动浏览器 ──────────────────────────────────────────────────────
        browser = await pw.chromium.launch(
            channel=BROWSER_CHANNEL,
            headless=BROWSER_HEADLESS,
            args=BROWSER_ARGS + [f"--window-size={BROWSER_WINDOW_SIZE}"],
        )

        # ── 创建浏览器上下文 ────────────────────────────────────────────────
        context = await browser.new_context(
            proxy=proxy_config,
            service_workers="block",  # 阻止 Service Worker，避免缓存干扰拦截逻辑
        )

        page = await context.new_page()

        # ── 浏览器日志转发 ──────────────────────────────────────────────────
        # 将浏览器控制台日志和未捕获异常转发到 Python 终端，方便调试
        def _on_console(msg):
            tag = msg.type.upper()
            if tag == 'WARNING':
                tag = 'WARN'
            print(f"[browser:{tag}] {msg.text}")

        page.on('console', _on_console)
        page.on('pageerror', lambda err: print(f"[browser:PAGEERR] {err}"))

        # ── 路由①：移除 CSP + 注入配置和 RPC 框架到 HTML ──────────────────
        import base64
        # 先注入 window.__catConfig，CatWebService.js 启动时从中读取配置
        config_script = f'<script>window.__catConfig={_BROWSER_CONFIG};</script>'
        # 再将 CatWebService.js 编码为 data: URL 注入，避免额外网络请求
        catservice_data_url = "data:text/javascript;base64," + base64.b64encode(
            catservice_content.encode("utf-8")
        ).decode("ascii")
        inject_script = config_script + f'<script src="{catservice_data_url}"></script>'

        await context.route("**/*", make_strip_csp_handler(page, inject_script))

        # ── 路由②：请求拦截替换（从配置加载）────────────────────────────────
        # 遍历 config.intercepts 中的每条规则，为每个 pattern 注册独立的路由
        for rule in _INTERCEPT_RULES:
            await context.route(rule["pattern"], make_intercept_handler(rule["content"], rule["content_type"]))

        # ── 打开目标页面 ───────────────────────────────────────────────────
        print(f"[launcher] 正在打开 {PAGE_URL} ...")
        try:
            await page.goto(PAGE_URL, wait_until="domcontentloaded", timeout=GOTO_TIMEOUT)
        except Exception as e:
            # 超时不一定致命，CatWebService.js 可能已经注入，继续等待 RPC
            print(f"[launcher] goto 超时/异常（继续注入）: {e}")

        # ── 等待 RPC 注册完成 ───────────────────────────────────────────────
        # CatWebService.js 注册完所有 topic 后会设置 window.__catRpcDone = true
        print("[launcher] 等待 RPC 注册完成 (__catRpcDone)...")
        try:
            await page.wait_for_function(
                "() => window.__catRpcDone === true",
                timeout=RPC_WAIT_TIMEOUT,
            )
            print("[launcher] RPC 注册完成 ✓")
        except Exception as e:
            print(f"[launcher] RPC 注册超时: {e}")

        # ── 保持运行 ────────────────────────────────────────────────────────
        # 浏览器实例需要持续运行以响应 RPC 调用，直到用户手动关闭或 Ctrl+C
        print("[launcher] 浏览器已就绪。关闭此窗口或按 Ctrl+C 退出。")
        await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(launch())
