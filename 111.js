const WebSocket = require("ws");
const axios = require("axios");

// ==========================================
// 1. КОНФИГУРАЦИЯ
// ==========================================
const CONFIG = {
  apiUrl: "https://explorer.elliot.ai",
  wsUrl: "wss://mainnet.zklighter.elliot.ai/ws", // Добавлен /ws если требуется по доке

  telegram: {
    enabled: false,
    botToken: "8222776620:AAHPqgNOk8ZPEAI03ZBfxy0tDtGXoxJDaGE",
    chatId: "-1003610905611",
  },

  defaultThresholdUSD: 500000,
  customThresholdsUSD: {
    WBTC_USDC: 1000000,
    WETH_USDC: 500000,
  },

  maxDistancePercent: 3,
  alertCooldownMs: 300000,
  maxLevelsToScan: 50,

  MAX_SUBS_PER_SOCKET: 50,
  RECONNECT_DELAY: 5000,
};

const alertCache = new Map();

// ==========================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

async function sendTelegramAlert(message) {
  if (!CONFIG.telegram.enabled || !CONFIG.telegram.botToken.trim()) return;
  const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
  try {
    await axios.post(url, { chat_id: CONFIG.telegram.chatId, text: message, parse_mode: "Markdown" });
  } catch (e) {
    console.error("❌ TG Error:", e.response?.data?.description || e.message);
  }
}

function shouldAlert(symbol, side, price) {
  const key = `${symbol}_${side}_${price}`;
  const now = Date.now();
  if (alertCache.has(key) && now - alertCache.get(key) < CONFIG.alertCooldownMs) return false;
  alertCache.set(key, now);
  return true;
}

/**
 * Получение списка маркеров с метаданными (нужны ID)
 */
async function getMarkets() {
  try {
    const res = await axios.get(`${CONFIG.apiUrl}/api/markets`);
    // Lighter работает через market_id, сохраним маппинг
    const filteredCoins = res.data.filter((coin) => !coin.symbol.endsWith("/USDC"));

    const res = filteredCoins.data.map((m) => ({
      id: m.market_index,
      symbol: m.symbol,
    }));

    console.log(res);

    return res;
  } catch (e) {
    console.error("❌ Ошибка при получении тикеров:", e.message);
    process.exit(1);
  }
}

// ==========================================
// 3. ЛОГИКА WEBSOCKET
// ==========================================

function createSocketShard(markets, shardId) {
  const ws = new WebSocket(CONFIG.wsUrl);
  let pingInterval;

  ws.on("open", () => {
    console.log(`🌐 [Шард ${shardId}] Соединение установлено. Подписка...`);

    // В Lighter подписка идет на конкретный канал для каждого market_id
    markets.forEach((m) => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          channel: "orderbook",
          market_id: m.id,
        }),
      );
    });

    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 15000);
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data);

    // Обработка данных канала orderbook
    if (msg.channel === "orderbook" && msg.bids && msg.asks) {
      const market = markets.find((m) => m.id === msg.market_id);
      if (!market) return;

      const symbol = market.symbol;

      // Проверка на пустые стаканы
      if (msg.bids.length === 0 || msg.asks.length === 0) return;

      // В Lighter данные — это объекты {price, amount}
      const bestBid = parseFloat(msg.bids[0].price);
      const bestAsk = parseFloat(msg.asks[0].price);
      const midPrice = (bestBid + bestAsk) / 2;

      const threshold = CONFIG.customThresholdsUSD[symbol] || CONFIG.defaultThresholdUSD;

      const processSide = (levels, sideName) => {
        const depth = Math.min(levels.length, CONFIG.maxLevelsToScan);

        for (let i = 0; i < depth; i++) {
          const price = parseFloat(levels[i].price);
          const size = parseFloat(levels[i].amount);
          const sizeUSD = price * size;

          if (sizeUSD >= threshold) {
            const distance = Math.abs((price - midPrice) / midPrice) * 100;

            if (distance <= CONFIG.maxDistancePercent) {
              if (shouldAlert(symbol, sideName, price)) {
                const volM = (sizeUSD / 1000000).toFixed(2);
                const time = new Date().toLocaleTimeString();

                console.log(
                  `[${time}] 🚨 ${symbol.padEnd(10)} | ${sideName.padEnd(4)} | Цена: ${price} | $${volM}M | Дист: ${distance.toFixed(2)}%`,
                );

                const cleanSymbol = symbol.split("/")[0]; // Убираем /USDC
                const emoji = sideName === "BUY" ? "🟢 BUY" : "🔴 SELL";
                const tgMessage =
                  `🔷 *Lighter Exchange*\n` +
                  `*Инструмент:* \`${cleanSymbol}\`\n` +
                  `*Сторона:* \`${emoji}\`\n` +
                  `*Цена:* \`${price}\`\n` +
                  `*Объем:* \`$${volM}M\`\n` +
                  `*Дистанция:* \`${distance.toFixed(2)}%\``;

                sendTelegramAlert(tgMessage);
              }
            }
          }
        }
      };

      processSide(msg.bids, "BUY");
      processSide(msg.asks, "SELL");
    }
  });

  ws.on("error", (err) => console.error(`❌ [Шард ${shardId}] Ошибка:`, err.message));

  ws.on("close", (code) => {
    console.log(`🔌 [Шард ${shardId}] Переподключение через ${CONFIG.RECONNECT_DELAY}мс...`);
    clearInterval(pingInterval);
    setTimeout(() => createSocketShard(markets, shardId), CONFIG.RECONNECT_DELAY);
  });
}

// ==========================================
// 4. ГЛАВНЫЙ ЗАПУСК
// ==========================================

async function main() {
  console.log("🚀 Скринер Lighter запускается...");
  const allMarkets = await getMarkets();

  // Фильтруем те, что нам не нужны (как в вашем коде)
  const filteredMarkets = allMarkets.filter((m) => !m.symbol.endsWith("/USDC"));

  // Если после фильтрации пусто, берем все (для теста Lighter это часто нужно)
  const marketsToSub = filteredMarkets.length > 0 ? filteredMarkets : allMarkets;

  console.log(`📊 Всего рынков для мониторинга: ${marketsToSub.length}`);

  for (let i = 0; i < marketsToSub.length; i += CONFIG.MAX_SUBS_PER_SOCKET) {
    const shardMarkets = marketsToSub.slice(i, i + CONFIG.MAX_SUBS_PER_SOCKET);
    const shardId = Math.floor(i / CONFIG.MAX_SUBS_PER_SOCKET) + 1;
    createSocketShard(shardMarkets, shardId);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main();
