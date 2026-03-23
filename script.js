const WebSocket = require("ws");
const axios = require("axios");

// ==========================================
// 1. КОНФИГУРАЦИЯ
// ==========================================
const CONFIG = {
  // Эндпоинт для получения списка тикеров (API)
  apiUrl: "https://explorer.elliot.ai",
  // Эндпоинт для WebSocket (Stream)
  wsUrl: "wss://mainnet.zklighter.elliot.ai/stream",

  // --- Настройки Telegram ---
  telegram: {
    enabled: true, // Поставьте true, когда впишете данные
    // botToken: "",
    botToken: "8222776620:AAHPqgNOk8ZPEAI03ZBfxy0tDtGXoxJDaGE",
    // chatId: "",
    chatId: "-1003610905611",
  },

  // --- Пороги объема в USD ---
  defaultThresholdUSD: 500_000,
  customThresholdsUSD: {
    BTC: 30000000, // 30 млн $
    ETH: 20000000, // 20 млн $
    SOL: 10000000, // 10 млн $
    XRP: 10000000, // 10 млн $
    HYPE: 5000000, // 5 млн $
    "1000PEPE": 1000000, // 1 млн $
    DOGE: 1000000, // 1 млн $
    PAXG: 10000000, // 10 млн $
    BNB: 10000000, // 10 млн $
    SEI: 5000000, // 5 млн $
    ZEC: 1000000, // 1 млн $
    LTC: 2000000, // 2 млн $
    AAVE: 1000000, // 1 млн $
    NEAR: 1000000, // 1 млн $
    XAU: 5000000, // 5 млн $
    DASH: 700000, // 0,7 млн $
    WTI: 2000000, // 2 млн $
    XAG: 2000000, // 2 млн $
    MET: 700000, // 0.7 млн $
    EURUSD: 5000000, // 5 млн $
    SKHYNIX: 5000000, // 5 млн $
    USDKRW: 5000000, // 5 млн $
    XPT: 2000000, // 2 млн $
  },

  // --- Оптимизация ---
  maxDistancePercent: 3,
  alertCooldownMs: 300000, // 5 минут
  maxLevelsToScan: 50, // Глубина сканирования

  // --- Технические настройки ---
  MAX_SUBS_PER_SOCKET: 100, // Ограничиваем кол-во пар на один сокет
  RECONNECT_DELAY: 5000,
};

const alertCache = new Map();
const symbolsInfo = new Map();

// ==========================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

async function sendTelegramAlert(message) {
  if (!CONFIG.telegram.enabled || !CONFIG.telegram.botToken.trim()) return;

  const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CONFIG.telegram.chatId,
      text: message,
      parse_mode: "Markdown",
    });
  } catch (e) {
    console.error("❌ TG Error:", e.response?.data?.description || e.message);
  }
}

function shouldAlert(symbol, side, price) {
  const key = `${symbol}_${side}_${price}`;
  const now = Date.now();
  if (alertCache.has(key) && now - alertCache.get(key) < CONFIG.alertCooldownMs) return false;
  alertCache.set(key, now);

  if (alertCache.size > 2000) {
    for (let [k, v] of alertCache) if (now - v > CONFIG.alertCooldownMs) alertCache.delete(k);
  }
  return true;
}

/**
 * Получение списка всех тикеров
 */
async function getTickers() {
  try {
    const res = await axios.get(`${CONFIG.apiUrl}/api/markets`);

    const tickers = res.data.filter((coin) => !coin.symbol.endsWith("/USDC"));

    tickers.forEach((ticker) => {
      symbolsInfo.set(ticker.market_index, ticker.symbol);
    });

    console.log(`✅ Найдено ${tickers.length} тикеров на Lighter`);
    console.log(tickers);
    return tickers;
  } catch (e) {
    console.error("❌ Ошибка при получении тикеров:", e.message);
    process.exit(1);
  }
}

// ==========================================
// 3. ЛОГИКА WEBSOCKET
// ==========================================

function createSocketShard(symbols, shardId) {
  const ws = new WebSocket(CONFIG.wsUrl);
  let pingInterval;

  ws.on("open", () => {
    console.log(`🌐 [Шард ${shardId}] Соединение открыто. Подписка на ${symbols.length} пар...`);

    // Формируем параметры в стиле Binance: ["btc@depth", "eth@depth"]

    symbols.forEach(({ market_index }) => {
      const subPayload = {
        type: "subscribe",
        channel: `order_book/${market_index}`,
      };

      const text = JSON.stringify(subPayload);
      ws.send(text);
    });

    // Поддержание соединения
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: "PING", id: Date.now() }));
      }
    }, 20000);
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data);

    // Пропуск подтверждения подписки или пинга
    if (!msg.order_book) return;

    // В Lighter V3 данные стакана приходят в полях 'b' (bids) и 'a' (asks)
    // Либо в событии depthUpdate
    const { bids, asks } = msg.order_book || {};
    if (!bids || !asks) return;
    if (bids.length > 0 && asks.length > 0) {
      const symbol = symbolsInfo.get(+msg.channel.split(":")[1]);

      const threshold = CONFIG.customThresholdsUSD[symbol] || CONFIG.defaultThresholdUSD;

      const bestBid = parseFloat(bids[0].price);
      const bestAsk = parseFloat(asks[0].price);
      const midPrice = (bestBid + bestAsk) / 2;

      const processSide = (levels, sideName) => {
        const depth = Math.min(levels.length, CONFIG.maxLevelsToScan);

        for (let i = 0; i < depth; i++) {
          const price = parseFloat(levels[i].price);
          const size = parseFloat(levels[i].size);
          const sizeUSD = price * size;

          if (sizeUSD >= threshold) {
            const distance = Math.abs((price - midPrice) / midPrice) * 100;

            if (distance <= CONFIG.maxDistancePercent) {
              if (shouldAlert(symbol, sideName, price)) {
                const volM = (sizeUSD / 1000000).toFixed(2);
                const time = new Date().toLocaleTimeString();

                const logMsg = `[${time}] 🚨 ${symbol.padEnd(8)} | ${sideName.padEnd(4)} | Цена: ${price} | Объем: $${volM}M | Дист: ${distance.toFixed(2)}%`;
                console.log(logMsg);

                const emoji = sideName === "BUY" ? "🟢 BUY (Bid)" : "🔴 SELL (Ask)";
                const tgMessage =
                  `⬛ *Lighter*\n` +
                  `*Инструмент:* \`${symbol}\`\n` +
                  `*Сторона:* \`${emoji}\`\n` +
                  `*Цена:* \`${price.toString().replace(".", ",")}\`\n` +
                  `*Объем:* \`$${volM}M\`\n` +
                  `*Дистанция:* \`${distance.toFixed(2)}%\``;
                // console.log(tgMessage);

                sendTelegramAlert(tgMessage);
              }
            }
          }
        }
      };

      processSide(bids, "BUY");
      processSide(asks, "SELL");
    }
  });

  ws.on("error", (err) => console.error(`❌ [Шард ${shardId}] Ошибка:`, err.message));

  ws.on("close", (code) => {
    console.log(
      `🔌 [Шард ${shardId}] Соединение закрыто (Код: ${code}). Реконнект через ${CONFIG.RECONNECT_DELAY}мс...`,
    );
    clearInterval(pingInterval);
    setTimeout(() => createSocketShard(symbols, shardId), CONFIG.RECONNECT_DELAY);
  });
}

// ==========================================
// 4. ГЛАВНЫЙ ЗАПУСК
// ==========================================

async function main() {
  console.log("🚀 Скринер Lighter V3 запускается...");
  const allTickers = await getTickers();

  // Разбиваем тикеры на группы по MAX_SUBS_PER_SOCKET
  for (let i = 0; i < allTickers.length; i += CONFIG.MAX_SUBS_PER_SOCKET) {
    const shardSymbols = allTickers.slice(i, i + CONFIG.MAX_SUBS_PER_SOCKET);
    const shardId = Math.floor(i / CONFIG.MAX_SUBS_PER_SOCKET) + 1;
    createSocketShard(shardSymbols, shardId);
    // Небольшая задержка перед открытием следующего сокета
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main();
