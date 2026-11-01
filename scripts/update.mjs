import { readFile, writeFile, mkdir } from "node:fs/promises";

const MA_LEN = 200;
const CHART_POINTS = 260; // ~1 year of trading days kept for the chart
const FILE = "docs/data/latest.json";

const SYMBOLS = (process.env.SYMBOLS || "QQQ,SPY")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const { TIINGO_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

async function main() {
  if (!TIINGO_TOKEN) throw new Error("TIINGO_TOKEN is not set");

  if (process.env.TEST_TELEGRAM === "true") {
    await notify("✅ Test alert from your 200 MA tracker");
  }

  let prev = {};
  try {
    prev = JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    /* first run: no file yet */
  }
  const prevSymbols = prev.symbols || {};
  const prevAlerted = prev.alerted || {};

  const symbols = { ...prevSymbols };
  const alerted = { ...prevAlerted };
  let failed = false;

  for (const sym of SYMBOLS) {
    try {
      const { result, message } = await processSymbol(sym);
      symbols[sym] = result;

      // Alert once per bar date per symbol, even though the cron runs twice
      if (message && alerted[sym] !== result.date) {
        await notify(message);
        alerted[sym] = result.date;
      }
    } catch (e) {
      failed = true;
      console.error(`[${sym}]`, e.message);
    }
  }

  // Only write (and therefore commit) when something actually changed
  const changed =
    JSON.stringify(symbols) !== JSON.stringify(prevSymbols) ||
    JSON.stringify(alerted) !== JSON.stringify(prevAlerted);

  if (changed) {
    await mkdir("docs/data", { recursive: true });
    await writeFile(
      FILE,
      JSON.stringify({ updated: new Date().toISOString(), symbols, alerted })
    );
    console.log("Wrote", FILE);
  } else {
    console.log("No changes");
  }

  if (failed) process.exit(1);
}

async function processSymbol(sym) {
  // ~800 calendar days gives ~550 trading bars: plenty for a 200 SMA + 1y chart
  const start = new Date(Date.now() - 800 * 86400000).toISOString().slice(0, 10);
  const url = `https://api.tiingo.com/tiingo/daily/${sym}/prices?startDate=${start}&format=json`;

  const r = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${TIINGO_TOKEN}`,
    },
  });
  if (!r.ok) throw new Error(`Tiingo HTTP ${r.status}`);

  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length < MA_LEN + 2) {
    throw new Error("Not enough data returned");
  }

  const dates = rows.map((b) => b.date.slice(0, 10));
  const closes = rows.map((b) => b.close); // raw close; use b.adjClose for dividend-adjusted
  const ma = sma(closes, MA_LEN);

  const n = closes.length - 1;
  const stateAt = (i) => (closes[i] > ma[i] ? "above" : "below");

  const today = { date: dates[n], close: closes[n], ma: ma[n], state: stateAt(n) };
  const crossed = stateAt(n) !== stateAt(n - 1);

  let message = null;
  if (crossed) {
    const dir = today.state === "above" ? "ABOVE 📈" : "BELOW 📉";
    const pct = ((today.close / today.ma - 1) * 100).toFixed(2);
    message =
      `${sym} closed ${dir} its ${MA_LEN}-day MA\n` +
      `Date: ${today.date}\n` +
      `Close: ${today.close.toFixed(2)}\n` +
      `200 MA: ${today.ma.toFixed(2)} (${pct}%)`;
  }

  // Consecutive trading days spent in the current state
  let daysInState = 0;
  for (let i = n; i >= MA_LEN - 1; i--) {
    if (stateAt(i) !== today.state) break;
    daysInState++;
  }

  const from = Math.max(MA_LEN - 1, closes.length - CHART_POINTS);
  const series = [];
  for (let i = from; i <= n; i++) {
    series.push({ d: dates[i], c: round(closes[i]), ma: round(ma[i]) });
  }

  return {
    result: {
      date: today.date,
      close: round(today.close),
      ma: round(today.ma),
      state: today.state,
      pctFromMA: round((today.close / today.ma - 1) * 100),
      daysInState,
      crossed,
      series,
    },
    message,
  };
}

function sma(values, len) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

const round = (x) => Math.round(x * 100) / 100;

async function notify(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram not configured] would send:\n" + text);
    return;
  }
  const r = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    }
  );
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${await r.text()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
