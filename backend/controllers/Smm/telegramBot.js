// Telegram bot & SMM balance cron encapsulation
require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const Telegram = require('../../models/Telegram');
const SmmSv = require('../../models/SmmSv');
const SmmApiService = require('./smmServices');
const userController = require('../user/userControlll');

let bot = null;
let botRetry = 0;
let botRestartTimer = null;
let currentBotToken = null;
let telegramConfigWatcherStarted = false;
const MAX_RETRY_DELAY = 30000; // 30s

async function scheduleBotRestart(reason) {
  if (botRestartTimer) return;
  const delay = Math.min(MAX_RETRY_DELAY, 1500 * Math.pow(2, botRetry));
  botRetry++;
  console.warn(`[TelegramBot] Sẽ thử khởi động lại sau ${delay}ms. Lý do: ${reason}`);
  botRestartTimer = setTimeout(() => {
    botRestartTimer = null;
    initTelegramBot();
  }, delay);
}

async function initTelegramBot() {
  try {
    const teleConfig = await Telegram.findOne();
    if (!teleConfig || !teleConfig.bot_notify) {
      console.warn('Telegram bot token (bot_notify) chưa cấu hình. Bỏ qua khởi tạo bot.');
      if (bot) {
        try { await bot.stopPolling(); } catch (_) { }
        bot = null;
      }
      currentBotToken = null;
      return;
    }
    const token = teleConfig.bot_notify;
    if (bot) {
      try { await bot.stopPolling(); } catch (_) { }
      bot = null;
    }
    try { await axios.get(`https://api.telegram.org/bot${token}/deleteWebhook`); } catch (_) { }
    bot = new TelegramBot(token, { polling: { interval: 1000, autoStart: true, params: { timeout: 50 } } });
    global.bot = bot;
    botRetry = 0;
    currentBotToken = token;
    console.log('Telegram bot polling started.');
    bot.on('message', async (msg) => {
      try {
        if (!msg || !msg.chat || !msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text.trim();
        await userController.processTelegramCommand(chatId, text);
      } catch (err) {
        console.error('Bot message handler error:', err.message);
      }
    });
    bot.on('polling_error', (err) => {
      const code = err.code || '';
      const msg = err.message || '';
      console.error('[TelegramBot] polling_error:', code, msg);
      if (code === 'EFATAL' || msg.includes('ECONNRESET') || msg.includes('ETELEGRAM: 401')) {
        scheduleBotRestart(code || 'polling_error');
      }
    });
    bot.on('error', (err) => console.error('[TelegramBot] error:', err.message));
  } catch (err) {
    console.error('Init Telegram bot error:', err.message);
    scheduleBotRestart('init_failed');
  }
}

function startTelegramConfigWatcher() {
  if (telegramConfigWatcherStarted) return;
  telegramConfigWatcherStarted = true;
  const interval = parseInt(process.env.TELEGRAM_WATCH_INTERVAL_MS || '60000');
  setInterval(async () => {
    try {
      const teleConfig = await Telegram.findOne();
      const newToken = teleConfig && teleConfig.bot_notify ? teleConfig.bot_notify : null;
      if (newToken !== currentBotToken) {
        console.log('[TelegramBot] Phát hiện thay đổi bot_notify. Restart bot...');
        botRetry = 0;
        await initTelegramBot();
      }
    } catch (e) {
      console.error('[TelegramBot] watcher error:', e.message);
    }
  }, Math.max(5000, interval));
}

// ===== SMM balance cron =====
const SMM_CHECK_CRON = process.env.SMM_CHECK_CRON || '*/15 * * * *';
// Threshold is now taken from each panel's `minbalance` field (per-partner setting)
const SMM_BALANCE_TIMEOUT_MS = Number(process.env.SMM_BALANCE_TIMEOUT_MS || 15000);

async function fetchPanelBalance(panel) {
  const api = new SmmApiService(panel.url_api, panel.api_token);
  const controller = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), SMM_BALANCE_TIMEOUT_MS));
  return Promise.race([
    api.balance(),
    controller
  ]);
}

async function checkSmmBalancesAndNotify() {
  try {
    const teleConfig = await Telegram.findOne();
    if (!teleConfig || !teleConfig.botToken || !teleConfig.chatidsdnguon) return;
    const panels = await SmmSv.find({ status: 'on' });
    if (!panels.length) return;
    const lowPanels = [];
    for (const p of panels) {
      if (p.ordertay === true) {
        continue;
      }

      try {
        const data = await fetchPanelBalance(p);
        let rawBalance = parseFloat((data.balance ?? '').toString().trim());
        if (Number.isNaN(rawBalance)) continue;
        let converted = rawBalance;
        if (data.currency === 'USD') converted = rawBalance * (p.tigia || 1) * 1000;
        else if (data.currency === 'XU') converted = rawBalance * (p.tigia || 1);
        const threshold = typeof p.minbalance === 'number' && !Number.isNaN(p.minbalance)
          ? p.minbalance
          : 100000; // fallback if not set
        if (converted < threshold) {
          lowPanels.push({ name: p.name, balance: converted, currency: data.currency, raw: rawBalance, threshold });
        }
      } catch (_) { /* ignore panel error */ }
    }
    if (lowPanels.length) {
      const taoluc = new Date(Date.now() + 7 * 60 * 60 * 1000).toLocaleString('vi-VN');
      const lines = lowPanels
        .map(p => `• ${p.name}: ${Math.round(p.balance).toLocaleString('en-US')} VND < ${Math.round(p.threshold).toLocaleString('en-US')} VND`)
        .join('\n');
      const msg = `⚠️ *Cảnh báo số dư ĐỐI TÁC thấp*\n${lines}\n⏰ ${taoluc}`;
      try {
        await axios.post(`https://api.telegram.org/bot${teleConfig.botToken}/sendMessage`, {
          chat_id: teleConfig.chatidsdnguon,
          text: msg.replace(/_/g, '\\_'),
          parse_mode: 'Markdown'
        });
      } catch (e) { console.error('Send low balance telegram error:', e.message); }
    }
  } catch (e) {
    console.error('Cron check SMM balance error:', e.message);
  }
}

function startSmmCron() {
  cron.schedule(SMM_CHECK_CRON, checkSmmBalancesAndNotify);
}

function bootstrapTelegramAndCrons() {
  initTelegramBot();
  startTelegramConfigWatcher();
  startSmmCron();
}

module.exports = {
  bootstrapTelegramAndCrons,
  initTelegramBot,
  startTelegramConfigWatcher,
  startSmmCron
};