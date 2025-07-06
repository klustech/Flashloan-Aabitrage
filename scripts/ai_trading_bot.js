const ccxt = require("ccxt");
const { EMA, VWAP, ATR } = require("technicalindicators");
require("dotenv").config({ override: true });

// Exchange configuration
const exchange = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET,
  enableRateLimit: true,
});

const SYMBOL = process.env.SYMBOL || "BTC/USDT";
const TIMEFRAME = process.env.TIMEFRAME || "1m";
const ORDER_SIZE = parseFloat(process.env.ORDER_SIZE || "0.001");

async function fetchCandles() {
  const raw = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 100);
  return raw.map((c) => ({
    time: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
  }));
}

function indicators(data) {
  const closes = data.map((c) => c.close);
  const highs = data.map((c) => c.high);
  const lows = data.map((c) => c.low);
  const volumes = data.map((c) => c.volume);

  const vwapSeries = VWAP.calculate({
    close: closes,
    volume: volumes,
    period: 20,
  });
  const ema50Series = EMA.calculate({ period: 50, values: closes });
  const atrSeries = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14,
  });

  return {
    vwap: vwapSeries[vwapSeries.length - 1],
    ema50: ema50Series[ema50Series.length - 1],
    atr: atrSeries[atrSeries.length - 1],
    lowerBand: Math.min(...vwapSeries.slice(-20)),
    upperBand: Math.max(...vwapSeries.slice(-20)),
    resistance: Math.max(...closes.slice(-20)),
    support: Math.min(...closes.slice(-20)),
  };
}

async function placeOrders(side, price, sl, tp) {
  if (side === "long") {
    await exchange.createMarketBuyOrder(SYMBOL, ORDER_SIZE);
    await exchange.createOrder(
      SYMBOL,
      "take-profit-market",
      "sell",
      ORDER_SIZE,
      undefined,
      { stopPrice: price + tp }
    );
    await exchange.createOrder(
      SYMBOL,
      "stop-market",
      "sell",
      ORDER_SIZE,
      undefined,
      { stopPrice: price - sl }
    );
  } else {
    await exchange.createMarketSellOrder(SYMBOL, ORDER_SIZE);
    await exchange.createOrder(
      SYMBOL,
      "take-profit-market",
      "buy",
      ORDER_SIZE,
      undefined,
      { stopPrice: price - tp }
    );
    await exchange.createOrder(
      SYMBOL,
      "stop-market",
      "buy",
      ORDER_SIZE,
      undefined,
      { stopPrice: price + sl }
    );
  }
}

async function run() {
  try {
    const candles = await fetchCandles();
    const last = candles[candles.length - 1];
    const { ema50, atr, lowerBand, upperBand, resistance, support } =
      indicators(candles);

    const sl = 1.5 * atr;
    const tp = 3 * atr;

    const longCond =
      (last.close < lowerBand && last.close > support) || last.close < ema50;
    const shortCond = last.close > upperBand && last.close < resistance;

    if (longCond) {
      console.log(`LONG @ ${last.close}`);
      await placeOrders("long", last.close, sl, tp);
    } else if (shortCond) {
      console.log(`SHORT @ ${last.close}`);
      await placeOrders("short", last.close, sl, tp);
    } else {
      console.log("No trade signal");
    }
  } catch (err) {
    console.error("Bot error:", err.message || err);
  }
}

run();
setInterval(run, 60 * 1000);
