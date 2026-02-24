/**
 * Web 控制面板服务端
 *
 * 提供：
 *   - 静态页面：/ （public/index.html）
 *   - API：
 *       POST /api/start  { code, platform, farmIntervalSec, friendIntervalSec }
 *       POST /api/stop
 *       GET  /api/status
 *       GET  /api/qr/login  获取扫码登录 URL 与 loginCode（仅 QQ）
 *       GET  /api/qr/status?loginCode=xxx  轮询扫码状态，成功返回 { status:'OK', code }
 */

const path = require('path');
const express = require('express');

const { CONFIG } = require('./src/config');
const { loadProto } = require('./src/proto');
const { connect, cleanup, getWs } = require('./src/network');
const { startFarmCheckLoop, stopFarmCheckLoop } = require('./src/farm');
const { startFriendCheckLoop, stopFriendCheckLoop } = require('./src/friend');
const { initTaskSystem, cleanupTaskSystem } = require('./src/task');
const { initStatusBar, cleanupStatusBar, setStatusPlatform } = require('./src/status');
const { startSellLoop, stopSellLoop, debugSellFruits } = require('./src/warehouse');
const { processInviteCodes } = require('./src/invite');
const { emitRuntimeHint } = require('./src/utils');
const { statusData } = require('./src/status');
const { requestLoginCode, queryScanStatus, getAuthCode } = require('./src/qqQrLogin');

const app = express();
const PORT = process.env.PORT || 3000;

let running = false;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function stopBot() {
    if (!running) return;
    running = false;
    try {
        cleanupStatusBar();
        stopFarmCheckLoop();
        stopFriendCheckLoop();
        cleanupTaskSystem();
        stopSellLoop();
        cleanup();
        const ws = getWs();
        if (ws) ws.close();
    } catch (e) {
        console.error('[server] stopBot error:', e);
    }
}

app.get('/api/status', (req, res) => {
    res.json({
        running,
        platform: CONFIG.platform,
        farmCheckInterval: CONFIG.farmCheckInterval,
        friendCheckInterval: CONFIG.friendCheckInterval,
        status: statusData,
    });
});

app.post('/api/start', async (req, res) => {
    if (running) {
        return res.status(400).json({ error: '挂机已在运行中' });
    }
    const { code, platform, farmIntervalSec, friendIntervalSec } = req.body || {};
    if (!code || typeof code !== 'string') {
        return res.status(400).json({ error: '缺少 code 参数' });
    }

    if (platform === 'wx') CONFIG.platform = 'wx';
    if (platform === 'qq') CONFIG.platform = 'qq';
    if (Number.isFinite(farmIntervalSec)) CONFIG.farmCheckInterval = Math.max(farmIntervalSec, 1) * 1000;
    if (Number.isFinite(friendIntervalSec)) CONFIG.friendCheckInterval = Math.max(friendIntervalSec, 1) * 1000;

    try {
        await loadProto();
        initStatusBar();
        setStatusPlatform(CONFIG.platform);
        emitRuntimeHint(true);

        running = true;
        connect(code, async () => {
            await processInviteCodes();
            startFarmCheckLoop();
            startFriendCheckLoop();
            initTaskSystem();
            setTimeout(() => debugSellFruits(), 5000);
            startSellLoop(60000);
        });

        res.json({ success: true });
    } catch (err) {
        running = false;
        res.status(500).json({ error: err.message || String(err) });
    }
});

app.post('/api/stop', (req, res) => {
    stopBot();
    res.json({ success: true });
});

// 获取 QQ 扫码登录二维码：返回 { url, loginCode }
app.get('/api/qr/login', async (req, res) => {
    try {
        const { loginCode, url } = await requestLoginCode();
        res.json({ url, loginCode });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

// 轮询扫码状态：?loginCode=xxx 返回 { status: 'Wait'|'OK'|'Used'|'Error', code? }
app.get('/api/qr/status', async (req, res) => {
    const loginCode = req.query.loginCode;
    if (!loginCode) {
        return res.status(400).json({ error: '缺少 loginCode' });
    }
    try {
        const result = await queryScanStatus(loginCode);
        if (result.status === 'OK' && result.ticket) {
            const code = await getAuthCode(result.ticket);
            return res.json({ status: 'OK', code });
        }
        res.json({ status: result.status });
    } catch (err) {
        res.status(500).json({ status: 'Error', error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Web 控制面板: http://localhost:${PORT}`);
});
