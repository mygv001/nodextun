// 域名:443/xt -> x-tunnel, /vless -> VLESS+WS, /vmess -> VMess+WS, /trojan -> Trojan+WS
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const net = require('net');

// ================= 1. 配置参数 =================
const USER_VARS = {
    UUID: process.env.UUID || "8b8eed54-afe0-4370-9689-579d6fbe1d81",
    // 路径配置 (分流路径)
    XRAY_PATH: process.env.XRAY_PATH || "/vless",
    VMESS_PATH: process.env.VMESS_PATH || "/vmess",
    TROJAN_PATH: process.env.TROJAN_PATH || "/trojan",
    XTUNNEL_PATH: process.env.XTUNNEL_PATH || "/xt",
    
    XTUNNEL_TOKEN: process.env.XTUNNEL_TOKEN || "",
    
    CF_JSON: process.env.CF_JSON || '',
    CF_TUNNEL_NAME: process.env.CF_TUNNEL_NAME || "", 
    CF_DOMAIN: process.env.CF_DOMAIN || "",
    
    SUB_PATH: process.env.SUB_PATH || "/sub",
    EXPORT_PATH: "/export_sub", // 订阅导出路径
    PANEL_PASS: process.env.PANEL_PASS || "",
    
    XRAY_START: (process.env.XRAY_START || "0") === "1",
    XTUNNEL_START: (process.env.XTUNNEL_START || "1") === "1",
    KOMARI_START: (process.env.KOMARI_START || "0") === "1",
    CF_START: true, 

    // 内部端口分配
    XRAY_PORT: 8401,     // VLESS WS
    VMESS_PORT: 8402,    // VMess WS
    TROJAN_PORT: 8403,   // Trojan WS
    XTUNNEL_PORT: 8405,   
    WEB_PORT: parseInt(process.env.PORT || 80 ), 

    KOMARI_ENDPOINT: process.env.KOMARI_ENDPOINT || '',
    KOMARI_TOKEN: process.env.KOMARI_TOKEN || '',
    MAX_LOG_LINES: 30 
};

let runningLogs = []; 
const INSTANCES = {};
const STOP_STATE = { xray: true, xtunnel: true, cloudflared: true, komari: true };
const WORK_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR);

const CF_CREDS_PATH = path.join(WORK_DIR, 'cf_creds.json');
const ARCH = os.arch() === 'x64' ? 'amd64' : 'arm64';
const X_ARCH = os.arch() === 'x64' ? '64' : 'arm64-v8a';

// ================= 2. 进程配置 =================
const CONFIG = {
    services: {
        xray: { enabled: USER_VARS.XRAY_START, bin: path.join(WORK_DIR, 'xray'), url: `https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${X_ARCH}.zip`, isZip: true, args: ['run', '-config', path.join(WORK_DIR, 'xray_config.json')] },
        xtunnel: { enabled: USER_VARS.XTUNNEL_START, bin: path.join(WORK_DIR, 'x-tunnel'), url: `https://www.baipiao.eu.org/xtunnel/x-tunnel-linux-${ARCH}`, args: ['-l', `ws://127.0.0.1:${USER_VARS.XTUNNEL_PORT}`, '-token', USER_VARS.XTUNNEL_TOKEN] },
        cloudflared: { enabled: USER_VARS.CF_START, bin: path.join(WORK_DIR, 'cloudflared'), url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}`, args: ['tunnel', '--no-autoupdate', '--edge-ip-version', '4', '--protocol', 'http2', 'run', '--credentials-file', CF_CREDS_PATH, '--url', `http://127.0.0.1:${USER_VARS.WEB_PORT}`, USER_VARS.CF_TUNNEL_NAME] },
        komari: { enabled: USER_VARS.KOMARI_START, bin: path.join(WORK_DIR, 'komari-agent'), url: `https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-${ARCH}`, args: ['-e', USER_VARS.KOMARI_ENDPOINT, '-t', USER_VARS.KOMARI_TOKEN] }
    }
};

// ================= 3. 核心工具函数 =================

function addLog(key, msg, isError = false) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const label = isError ? `[${key}!]` : `[${key}]`; 
    const formatted = `[${time}] ${label} ${msg.trim().split('\n')[0]}`;
    console.log(formatted);
    runningLogs.push(formatted);
    if (runningLogs.length > USER_VARS.MAX_LOG_LINES) runningLogs.shift();
}

async function downloadFile(key) {
    const item = CONFIG.services[key];
    if (fs.existsSync(item.bin) && fs.statSync(item.bin).size > 0) return true;
    addLog("系统", `正在部署 ${key}...`);
    try {
        const res = await fetch(item.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        if (item.isZip) {
            const zipPath = item.bin + ".zip";
            fs.writeFileSync(zipPath, buffer);
            execSync(`unzip -o "${zipPath}" -d "${WORK_DIR}" && rm "${zipPath}"`);
        } else { fs.writeFileSync(item.bin, buffer); }
        fs.chmodSync(item.bin, 0o755); 
        addLog("系统", `${key} 部署完成`);
        return true;
    } catch (err) { addLog("系统", `${key} 下载失败: ${err.message}`, true); return false; }
}

function startService(key) {
    if (INSTANCES[key]) return;
    if (!fs.existsSync(CONFIG.services[key].bin)) {
        addLog(key, "启动失败：文件不存在", true);
        return;
    }
    STOP_STATE[key] = false;
    const proc = spawn(CONFIG.services[key].bin, CONFIG.services[key].args, { cwd: WORK_DIR });
    proc.on('error', (err) => {
        addLog(key, `进程异常: ${err.message}`, true);
        INSTANCES[key] = null;
    });
    INSTANCES[key] = proc;
    proc.stdout.on('data', d => addLog(key, d.toString()));
    proc.stderr.on('data', d => addLog(key, d.toString())); 
    proc.on('exit', (code) => {
        INSTANCES[key] = null;
        if (!STOP_STATE[key]) {
            addLog("系统", `${key} 异常退出，5秒后重启...`, true);
            setTimeout(() => { if(!STOP_STATE[key]) startService(key); }, 5000);
        }
    });
}

function stopService(key) {
    if (INSTANCES[key]) {
        STOP_STATE[key] = true;
        addLog("控制", `停止服务: ${key}`);
        INSTANCES[key].kill();
        INSTANCES[key] = null;
    }
}

// ================= 4. 订阅生成逻辑 =================

function getLinks() {
    const domain = USER_VARS.CF_DOMAIN;
    const uuid = USER_VARS.UUID;

    // VLESS
    const vless = `vless://${uuid}@${domain}:443?encryption=none&security=tls&type=ws&host=${domain}&path=${encodeURIComponent(USER_VARS.XRAY_PATH)}#VLESS_${domain}`;
    
    // VMess
    const vmessJson = { v: "2", ps: `VMESS_${domain}`, add: domain, port: "443", id: uuid, aid: "0", scy: "auto", net: "ws", type: "none", host: domain, path: USER_VARS.VMESS_PATH, tls: "tls", sni: domain };
    const vmess = `vmess://${Buffer.from(JSON.stringify(vmessJson)).toString('base64')}`;
    
    // Trojan (密码同 UUID)
    const trojan = `trojan://${uuid}@${domain}:443?security=tls&type=ws&host=${domain}&path=${encodeURIComponent(USER_VARS.TROJAN_PATH)}#TROJAN_${domain}`;

    return { vless, vmess, trojan };
}

// ================= 5. UI 界面与分流枢纽 =================

const COMMON_STYLE = `
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    :root { --main: #00ff41; --bg: #0a0a0a; --card: #161616; --btn-stop: #ff4141; }
    body { background: var(--bg); color: var(--main); font-family: 'Consolas', monospace; margin: 0; padding: 10px; display: flex; justify-content: center; }
    .wrapper { width: 100%; max-width: 1200px; }
    .card { background: var(--card); border: 1px solid #333; padding: 20px; border-radius: 12px; margin-bottom: 15px; }
    .header { font-size: 16px; font-weight: bold; margin-bottom: 12px; border-bottom: 1px solid #333; padding-bottom: 8px; text-align: center; color: #fff; }
    .main-layout { display: grid; grid-template-columns: 1fr; gap: 15px; }
    @media (min-width: 900px) { .main-layout { grid-template-columns: 450px 1fr; } }
    .service-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .s-card { background: #222; border: 1px solid #333; padding: 12px; border-radius: 10px; text-align: center; }
    .btn { display: block; width: 100%; border: none; padding: 10px 0; border-radius: 6px; font-weight: bold; cursor: pointer; text-decoration: none; font-size: 12px; margin-top: 8px; transition: 0.2s; }
    .btn-start { background: var(--main); color: #000; }
    .btn-stop { background: #333; color: var(--btn-stop); }
    .sub-box { background: #000; padding: 10px; border: 1px dashed #444; font-size: 10px; word-break: break-all; margin: 8px 0; color: #ffcc00; max-height: 60px; overflow-y: auto; }
    .log-container { background: #000; padding: 12px; border-radius: 8px; height: 500px; overflow-y: auto; font-size: 12px; color: #888; white-space: pre-wrap; line-height: 1.6; border: 1px solid #222; }
    .copy-btn { background: #444; color: #fff; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; }
</style>`;

const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;

    // 订阅导出接口 (Base64)
    if (pathname === USER_VARS.EXPORT_PATH) {
        const links = getLinks();
        const content = Buffer.from(Object.values(links).join('\n')).toString('base64');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(content);
    }

    if (pathname === USER_VARS.SUB_PATH) {
        const isAuth = (req.headers.cookie || "").includes(`sid=${USER_VARS.PANEL_PASS}`);
        if (urlObj.searchParams.get('pass') === USER_VARS.PANEL_PASS) {
            res.setHeader('Set-Cookie', `sid=${USER_VARS.PANEL_PASS}; Path=/; Max-Age=86400; HttpOnly`);
            res.writeHead(302, { 'Location': USER_VARS.SUB_PATH }); return res.end();
        }
        if (!isAuth) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(`<html><head>${COMMON_STYLE}</head><body><div class="card" style="max-width:350px;margin-top:100px;"><div class="header">IDENTITY AUTH</div><form action="${USER_VARS.SUB_PATH}"><input type="password" name="pass" style="width:100%;padding:10px;background:#000;border:1px solid #444;color:#0f0;text-align:center;"><button class="btn btn-start" style="margin-top:10px;">UNLOCK</button></form></div></body></html>`);
        }

        const action = urlObj.searchParams.get('action');
        const svc = urlObj.searchParams.get('service');
        if (action === 'start' && svc && CONFIG.services[svc]) {
            downloadFile(svc).then(ok => { if(ok) startService(svc); });
            res.writeHead(302, { 'Location': USER_VARS.SUB_PATH }); return res.end();
        }
        if (action === 'stop' && svc) {
            stopService(svc);
            res.writeHead(302, { 'Location': USER_VARS.SUB_PATH }); return res.end();
        }

        let cardsHtml = '';
        for (const s in CONFIG.services) {
            const isRun = !!INSTANCES[s];
            cardsHtml += `
            <div class="s-card">
                <div style="font-size:11px;opacity:0.5;margin-bottom:5px;">${s.toUpperCase()}</div>
                <div style="font-weight:bold;color:${isRun?'var(--main)':'#666'}">${isRun?'● ONLINE':'○ OFFLINE'}</div>
                <a href="?action=${isRun?'stop':'start'}&service=${s}" class="btn ${isRun?'btn-stop':'btn-start'}">${isRun?'STOP':'START'}</a>
            </div>`;
        }

        const links = getLinks();
        let subHtml = '';
        for (const [name, link] of Object.entries(links)) {
            subHtml += `
            <div style="margin-top:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center">
                    <span style="font-size:11px; color:#fff">${name.toUpperCase()} (WS)</span>
                    <button class="copy-btn" onclick="navigator.clipboard.writeText('${link}');this.innerText='COPIED!'">COPY</button>
                </div>
                <div class="sub-box">${link}</div>
            </div>`;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<html><head>${COMMON_STYLE}<title>Multiplex Panel</title></head><body><div class="wrapper"><div class="main-layout"><div class="card"><div class="header">SERVICES CONTROL</div><div class="service-grid">${cardsHtml}</div><div class="header" style="margin-top:20px;">SUBSCRIPTION LINKS</div>${subHtml}<div style="margin-top:15px; padding:10px; background:#333; border-radius:8px; font-size:10px; text-align:center">Sub URL:<br/><code style="color:var(--main)">http://${USER_VARS.CF_DOMAIN}${USER_VARS.EXPORT_PATH}</code></div></div><div class="card"><div class="header">REAL-TIME LOGS</div><pre class="log-container">${runningLogs.slice().reverse().join('\n')}</pre></div></div></div><script>setTimeout(()=> { if(!window.location.search) location.reload(); }, 10000);</script></body></html>`);
    }

    res.writeHead(200); res.end("Node Multiplexer Active");
});

// ================= 6. WebSocket 分流枢纽 =================

server.on('upgrade', (req, socket, head) => {
    const p = new URL(req.url, `http://${req.headers.host}`).pathname;
    let targetPort = null;

    if (p === USER_VARS.XRAY_PATH) targetPort = USER_VARS.XRAY_PORT;
    else if (p === USER_VARS.VMESS_PATH) targetPort = USER_VARS.VMESS_PORT;
    else if (p === USER_VARS.TROJAN_PATH) targetPort = USER_VARS.TROJAN_PORT;
    else if (p === USER_VARS.XTUNNEL_PATH) targetPort = USER_VARS.XTUNNEL_PORT;

    if (targetPort) {
        const target = net.connect(targetPort, '127.0.0.1', () => {
            let rawReq = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
            for (let h in req.headers) { rawReq += `${h}: ${req.headers[h]}\r\n`; }
            rawReq += '\r\n';
            target.write(rawReq);
            if (head && head.length > 0) target.write(head);
            socket.pipe(target).pipe(socket);
        });
        target.on('error', () => socket.destroy());
        socket.on('error', () => target.destroy());
    } else { socket.destroy(); }
});

// ================= 7. 启动流程 =================
async function main() {
    try { fs.writeFileSync(CF_CREDS_PATH, USER_VARS.CF_JSON); } catch (e) {}

    // 生成 Xray 配置 (移除了 gRPC)
    const xrayCfg = {
        inbounds: [
            { port: USER_VARS.XRAY_PORT, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: USER_VARS.UUID }], decryption: "none" }, streamSettings: { network: "ws", wsSettings: { path: USER_VARS.XRAY_PATH } } },
            { port: USER_VARS.VMESS_PORT, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: USER_VARS.UUID }] }, streamSettings: { network: "ws", wsSettings: { path: USER_VARS.VMESS_PATH } } },
            { port: USER_VARS.TROJAN_PORT, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: USER_VARS.UUID }] }, streamSettings: { network: "ws", wsSettings: { path: USER_VARS.TROJAN_PATH } } }
        ],
        outbounds: [{ protocol: "freedom" }]
    };
    fs.writeFileSync(path.join(WORK_DIR, 'xray_config.json'), JSON.stringify(xrayCfg, null, 2));
    
    server.listen(USER_VARS.WEB_PORT, '0.0.0.0', () => addLog("系统", `枢纽就绪，端口: ${USER_VARS.WEB_PORT}`));

    for (const key in CONFIG.services) {
        if (CONFIG.services[key].enabled) {
            const ok = await downloadFile(key);
            if (ok) startService(key);
        }
    }
}


main().catch(e => console.error("Critical Main Error:", e));
