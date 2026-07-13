// ============================================================
// GAMMA X BACKEND — Nifty + Sensex Fair Value & Gamma Blast Engine
// Angel One SmartAPI (auto-TOTP) + optionGreek auto-IV
// Env vars needed on Render: CLIENT_CODE, PIN, API_KEY, TOTP_SECRET,
// SHEET_WEBHOOK_URL (optional), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (for push alerts)
// ============================================================
const express = require('express');
const cors = require('cors');
const { authenticator } = require('otplib');
const webpush = require('web-push');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const clean = s => (s || '').trim();
const CLIENT_CODE = clean(process.env.CLIENT_CODE);
const PIN = clean(process.env.PIN);
const API_KEY = clean(process.env.API_KEY);
// TOTP secret: remove ALL spaces (SmartAPI page shows it with spaces) + uppercase
const TOTP_SECRET = clean(process.env.TOTP_SECRET).replace(/\s+/g, '').toUpperCase();
const RISK_FREE = parseFloat(process.env.RISK_FREE || '6.5');
const DIV_YIELD = parseFloat(process.env.DIV_YIELD || '1.1');

const BASE = 'https://apiconnect.angelone.in';

// Index config: Angel One spot tokens + lot sizes + weekly expiry weekday
// NIFTY weekly expiry = Tuesday (2), SENSEX weekly = Thursday (4)  [override via ?expiry=DDMMMYYYY]
const INDEXES = {
  NIFTY:  { exch: 'NSE', token: '99926000', symbol: 'Nifty 50', lot: 75, step: 50,  expiryDow: 2, greekName: 'NIFTY' },
  SENSEX: { exch: 'BSE', token: '99919000', symbol: 'SENSEX',   lot: 20, step: 100, expiryDow: 4, greekName: 'SENSEX' }
};

// ---------------- Session ----------------
let session = { jwt: null, feed: null, at: 0 };

function headers() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '106.193.147.98',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': API_KEY,
    ...(session.jwt ? { 'Authorization': 'Bearer ' + session.jwt } : {})
  };
}

async function login() {
  const totp = authenticator.generate(TOTP_SECRET);
  const r = await fetch(BASE + '/rest/auth/angelbroking/user/v1/loginByPassword', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ clientcode: CLIENT_CODE, password: PIN, totp })
  });
  let d;
  try { d = await r.json(); }
  catch (e) {
    const text = await r.text().catch(() => '');
    throw new Error('Login endpoint returned non-JSON (likely rate-limited/blocked): ' + text.slice(0, 120));
  }
  if (!d.status || !d.data) throw new Error('Login failed: ' + (d.message || 'unknown'));
  session = { jwt: d.data.jwtToken, feed: d.data.feedToken, at: Date.now() };
  console.log('✅ Angel One login OK');
  return session;
}

// Multiple parallel requests (analyze() fires several apiPost calls at once,
// PLUS the background alert scheduler runs independently) could all notice an
// expired session simultaneously and each try to log in — Angel's login
// endpoint is rate-limited and starts returning "Access Denied" HTML instead
// of JSON if hit too many times in a row. This mutex makes concurrent callers
// share ONE in-flight login instead of firing several at once.
let loginInFlight = null;
async function ensureSession() {
  if (session.jwt && Date.now() - session.at <= 6 * 3600 * 1000) return session;
  if (!loginInFlight) {
    loginInFlight = login().finally(() => { loginInFlight = null; });
  }
  await loginInFlight;
  return session;
}

async function apiPost(path, body, retry = true) {
  await ensureSession();
  const r = await fetch(BASE + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if ((d.errorcode === 'AG8001' || d.errorcode === 'AG8002' || d.message === 'Invalid Token') && retry) {
    session.jwt = null;
    return apiPost(path, body, false);
  }
  return d;
}

// ---------------- Market data ----------------
async function getSpot(idx) {
  const cfg = INDEXES[idx];
  const d = await apiPost('/rest/secure/angelbroking/order/v1/getLtpData', {
    exchange: cfg.exch, tradingsymbol: cfg.symbol, symboltoken: cfg.token
  });
  if (d.status && d.data && d.data.ltp) return parseFloat(d.data.ltp);
  throw new Error(idx + ' spot fetch failed: ' + (d.message || 'no data'));
}

// India VIX (NSE) — Sensex IV fallback ke liye
async function getVIX() {
  const d = await apiPost('/rest/secure/angelbroking/order/v1/getLtpData', {
    exchange: 'NSE', tradingsymbol: 'India VIX', symboltoken: '99926017'
  });
  if (d.status && d.data && d.data.ltp) return parseFloat(d.data.ltp);
  return null;
}

// ---------------- VIX Regime Shift ----------------
// India VIX jumping >7% in a day is itself a "big move day" flag. We compare
// live VIX against its previous close (via VIX daily candle history).
let vixDayCache = { date: null, prevClose: null };
async function getVIXRegime() {
  try {
    const vixNow = await getVIX();
    if (vixNow == null) return null;
    const today = istDateStr(istNow());
    if (vixDayCache.date !== today) {
      const from = istDateStr(new Date(istNow().getTime() - 7 * 86400000)) + ' 09:15';
      const to = today + ' 15:30';
      const d = await apiPost('/rest/secure/angelbroking/historical/v1/getCandleData', {
        exchange: 'NSE', symboltoken: '99926017', interval: 'ONE_DAY', fromdate: from, todate: to
      });
      const candles = (d.status && Array.isArray(d.data)) ? d.data : [];
      // previous close = second-to-last candle's close (last is today's forming candle)
      const prev = candles.length >= 2 ? candles[candles.length - 2][4] : (candles.length === 1 ? candles[0][4] : null);
      vixDayCache = { date: today, prevClose: prev };
    }
    const prevClose = vixDayCache.prevClose;
    const dayChangePct = prevClose ? +(((vixNow - prevClose) / prevClose) * 100).toFixed(2) : null;
    const regime = dayChangePct != null && dayChangePct > 7 ? 'SPIKE — big-move day conditions'
      : dayChangePct != null && dayChangePct < -7 ? 'CRUSH — vol collapsing, mean-revert bias'
      : 'NORMAL';
    return { vix: +vixNow.toFixed(2), prevClose: prevClose ? +prevClose.toFixed(2) : null, dayChangePct, regime };
  } catch (e) { return null; }
}

// ---------------- Multi-day Trend Regime ----------------
// Looks at the last N daily candles: lower-highs+lower-lows = DOWNTREND,
// higher-highs+higher-lows = UPTREND. Sustained structure means today's move
// is part of a real trend, not one-day noise.
async function getTrendRegime(idx) {
  try {
    const candles = await getDailyHistory(idx, 10); // reuses the daily cache
    if (candles.length < 4) return null;
    const recent = candles.slice(-4); // last 3 completed + today forming
    let lowerHighs = 0, lowerLows = 0, higherHighs = 0, higherLows = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i][2] < recent[i-1][2]) lowerHighs++; else if (recent[i][2] > recent[i-1][2]) higherHighs++;
      if (recent[i][3] < recent[i-1][3]) lowerLows++; else if (recent[i][3] > recent[i-1][3]) higherLows++;
    }
    const n = recent.length - 1;
    let regime = 'SIDEWAYS', note = 'No sustained multi-day structure';
    if (lowerHighs >= n - 1 && lowerLows >= n - 1) { regime = 'DOWNTREND'; note = 'Lower highs + lower lows for ' + n + ' sessions — sustained downtrend, today is part of a real trend'; }
    else if (higherHighs >= n - 1 && higherLows >= n - 1) { regime = 'UPTREND'; note = 'Higher highs + higher lows for ' + n + ' sessions — sustained uptrend'; }
    return { regime, note, sessionsChecked: n };
  } catch (e) { return null; }
}

// ---------------- FII/DII daily flows (NSE public data, best-effort) ----------------
let fiiDiiCache = { at: 0, data: null };
async function getFIIDII() {
  if (fiiDiiCache.data && Date.now() - fiiDiiCache.at < 60 * 60 * 1000) return fiiDiiCache.data;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 9000);
    const home = await fetch('https://www.nseindia.com/reports/fii-dii', {
      headers: { 'User-Agent': NSE_UA, 'Accept': 'text/html' }, signal: ctrl.signal
    });
    const cookies = (home.headers.getSetCookie ? home.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
    const r = await fetch('https://www.nseindia.com/api/fiidiiTradeReact', {
      headers: { 'User-Agent': NSE_UA, 'Accept': 'application/json', 'Cookie': cookies, 'Referer': 'https://www.nseindia.com/reports/fii-dii' },
      signal: ctrl.signal
    });
    clearTimeout(to);
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length) {
      const fii = arr.find(x => (x.category || '').toUpperCase().includes('FII') || (x.category || '').toUpperCase().includes('FPI'));
      const dii = arr.find(x => (x.category || '').toUpperCase().includes('DII'));
      const out = {
        date: (fii && fii.date) || null,
        fiiNetCr: fii ? +parseFloat(fii.netValue || 0).toFixed(0) : null,
        diiNetCr: dii ? +parseFloat(dii.netValue || 0).toFixed(0) : null,
        note: null
      };
      if (out.fiiNetCr != null) {
        out.note = out.fiiNetCr < -2000 ? 'Heavy FII selling — institutional distribution pressure'
          : out.fiiNetCr > 2000 ? 'Heavy FII buying — institutional accumulation'
          : 'FII flows moderate';
      }
      fiiDiiCache = { at: Date.now(), data: out };
      return out;
    }
    return null;
  } catch (e) { return null; }
}

// ---------------- Historical candles + 0.2711% Reversal Levels ----------------
async function getHistoricalCandles(idx, interval, fromdate, todate) {
  const cfg = INDEXES[idx];
  const d = await apiPost('/rest/secure/angelbroking/historical/v1/getCandleData', {
    exchange: cfg.exch, symboltoken: cfg.token, interval, fromdate, todate
  });
  if (d.status && Array.isArray(d.data)) return d.data; // [timestamp, open, high, low, close, volume][]
  throw new Error('historical candle fetch failed: ' + (d.message || JSON.stringify(d.errorcode || '')));
}

function istNow() { return new Date(Date.now() + 5.5 * 3600 * 1000); }
function istDateStr(d) {
  const yyyy = d.getUTCFullYear(), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}
function istTimeStr(d) {
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

// The 0.2711% first-5-min-candle reversal level strategy:
//   A = firstCandleHigh × (1 + 0.2711%)   → tends to reverse price down when approached
//   B = firstCandleLow  × (1 − 0.2711%)   → tends to reverse price up when approached
//   A close BEYOND either level (not just a touch) signals a bigger momentum move
async function computeReversalLevels(idx) {
  const now = istNow();
  const dateStr = istDateStr(now);
  const fromFirst = dateStr + ' 09:15';
  const toFirst = dateStr + ' 09:20';

  const firstCandles = await getHistoricalCandles(idx, 'FIVE_MINUTE', fromFirst, toFirst);
  if (!firstCandles.length) throw new Error('First 5-min candle not available yet (market may not have opened, or data not published yet)');
  const [ts, o, h, l, c] = firstCandles[0];
  const A = +(h * (1 + 0.002711)).toFixed(2);
  const B = +(l * (1 - 0.002711)).toFixed(2);

  let signal = 'NONE', signalTime = null;
  try {
    const nowStr = dateStr + ' ' + istTimeStr(now);
    const dayCandles = await getHistoricalCandles(idx, 'FIVE_MINUTE', fromFirst, nowStr);
    for (const cd of dayCandles) {
      const close = cd[4], t = cd[0];
      if (close > A) { signal = 'BULLISH_CONFIRMED'; signalTime = t; break; }
      if (close < B) { signal = 'BEARISH_CONFIRMED'; signalTime = t; break; }
    }
  } catch (e) { /* keep signal NONE if this secondary fetch fails */ }

  const spot = await getSpot(idx);
  return {
    index: idx, date: dateStr,
    firstCandle: { time: ts, open: o, high: h, low: l, close: c },
    A, B, spot: +spot.toFixed(2),
    distanceToA: +(A - spot).toFixed(2),
    distanceToB: +(spot - B).toFixed(2),
    signal, signalTime,
    note: 'A/B are reversal-tendency levels from the first 5-min candle (±0.2711%). A confirmed close beyond either level signals a larger momentum move in that direction, per your rule.'
  };
}

// ---------------- Historical Zone Clustering (automates your manual process) ----------------
// Your manual process: (1) scroll back through past days, find where price
// has previously reversed near a given price zone, (2) draw horizontal lines
// there, (3) cross-check today's OI/gamma at that zone before trusting it.
// This automates step 1-2 using Angel's real daily OHLC history, then step 3
// happens where it's combined with allLevels (live OI/gamma/IV) in the route.
let dailyHistoryCache = new Map(); // idx -> { date, days, candles }
async function getDailyHistory(idx, days) {
  const today = istDateStr(istNow());
  const cached = dailyHistoryCache.get(idx);
  if (cached && cached.date === today && cached.days === days) return cached.candles;
  const toD = istNow();
  const fromD = new Date(toD.getTime() - days * 86400000);
  const fromStr = istDateStr(fromD) + ' 09:15';
  const toStr = istDateStr(toD) + ' 15:30';
  const candles = await getHistoricalCandles(idx, 'ONE_DAY', fromStr, toStr);
  dailyHistoryCache.set(idx, { date: today, days, candles });
  return candles;
}

// Every day's High and Low is a place price actually reversed intraday — this
// clusters those points (across many past days) into zones by proximity, so a
// zone with many touches is exactly what you were finding manually.
function clusterSwingZones(candles, tolerancePct) {
  const points = [];
  for (const cd of candles) {
    const [ts, o, h, l, c] = cd;
    points.push({ price: h, type: 'HIGH', time: ts });
    points.push({ price: l, type: 'LOW', time: ts });
  }
  points.sort((a, b) => a.price - b.price);

  const clusters = [];
  let current = [];
  for (const p of points) {
    if (current.length === 0) { current.push(p); continue; }
    const last = current[current.length - 1];
    if (Math.abs(p.price - last.price) <= last.price * tolerancePct) current.push(p);
    else { clusters.push(current); current = [p]; }
  }
  if (current.length) clusters.push(current);

  const now = Date.now();
  return clusters
    .map(pts => {
      const center = pts.reduce((s, x) => s + x.price, 0) / pts.length;
      const lastTouch = Math.max(...pts.map(p => new Date(p.time).getTime()));
      const highCount = pts.filter(p => p.type === 'HIGH').length;
      const lowCount = pts.filter(p => p.type === 'LOW').length;
      return {
        level: +center.toFixed(2), touchCount: pts.length, highCount, lowCount,
        lastTouchDaysAgo: +((now - lastTouch) / 86400000).toFixed(1),
        type: highCount > lowCount ? 'RESISTANCE-HISTORY' : lowCount > highCount ? 'SUPPORT-HISTORY' : 'MIXED-HISTORY'
      };
    })
    .filter(z => z.touchCount >= 2); // singleton = noise, not a real zone
}

async function computeHistoricalZones(idx, days) {
  const candles = await getDailyHistory(idx, days);
  if (!candles.length) return [];
  const zones = clusterSwingZones(candles, 0.0015); // ~0.15% clustering tolerance
  const maxTouch = Math.max(...zones.map(z => z.touchCount), 1);
  for (const z of zones) {
    const recencyBoost = Math.max(0, 1 - z.lastTouchDaysAgo / days);
    z.historyScore = Math.round(100 * (0.7 * (z.touchCount / maxTouch) + 0.3 * recencyBoost));
  }
  return zones.sort((a, b) => b.historyScore - a.historyScore);
}

// ---------------- Breakout Cascade Confirmation ----------------
// A single level break can be a fakeout. But when price CLOSES beyond several
// historical zones in a row, in the same direction, within a short window —
// that's a real momentum move, not noise. This walks today's 5-min candles
// against the zone list and counts exactly that cascade, plus a volume check.
async function computeBreakoutConfirmation(idx, zones) {
  const now = istNow();
  const dateStr = istDateStr(now);
  const fromStr = dateStr + ' 09:15';
  const toStr = dateStr + ' ' + istTimeStr(now);

  let candles;
  try { candles = await getHistoricalCandles(idx, 'FIVE_MINUTE', fromStr, toStr); }
  catch (e) { return { direction: 'NONE', cascadeCount: 0, breaksInWindow: [], confirmationScore: 0, label: 'Intraday candle data unavailable right now' }; }
  if (candles.length < 2) return { direction: 'NONE', cascadeCount: 0, breaksInWindow: [], confirmationScore: 0, label: 'Not enough candles yet today' };

  const zoneLevels = zones.map(z => z.level).sort((a, b) => a - b);
  const breaks = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1][4], close = candles[i][4], time = candles[i][0];
    for (const lvl of zoneLevels) {
      if (prevClose < lvl && close > lvl) breaks.push({ time, level: lvl, direction: 'UP' });
      if (prevClose > lvl && close < lvl) breaks.push({ time, level: lvl, direction: 'DOWN' });
    }
  }
  if (!breaks.length) return { direction: 'NONE', cascadeCount: 0, breaksInWindow: [], confirmationScore: 0, label: 'No historical zone broken yet today' };

  const WINDOW_MS = 45 * 60 * 1000;
  const nowMs = new Date(candles[candles.length - 1][0]).getTime();
  const recent = breaks.filter(b => nowMs - new Date(b.time).getTime() <= WINDOW_MS);
  const upCount = recent.filter(b => b.direction === 'UP').length;
  const downCount = recent.filter(b => b.direction === 'DOWN').length;
  const direction = downCount > upCount ? 'DOWN' : upCount > downCount ? 'UP' : 'NONE';
  const cascadeCount = Math.max(upCount, downCount);

  const recentVol = candles.slice(-3).reduce((s, c) => s + c[5], 0) / 3;
  const priorCandles = candles.slice(0, -3);
  const priorVol = priorCandles.length ? priorCandles.reduce((s, c) => s + c[5], 0) / priorCandles.length : recentVol;
  const volRatio = priorVol > 0 ? recentVol / priorVol : 1;

  const confirmationScore = Math.round(Math.min(100, cascadeCount * 20 + Math.min(volRatio * 10, 30)));
  const label = cascadeCount >= 4 ? 'STRONG cascade — big move likely in progress'
    : cascadeCount >= 2 ? 'Moderate cascade — momentum building, watch for continuation'
    : 'Single break — could still reverse, wait for a 2nd zone to confirm';

  return {
    direction, cascadeCount, breaksInWindow: recent, volRatio: +volRatio.toFixed(2),
    confirmationScore, label,
    note: 'When price CLOSES beyond 2+ historical zones in the same direction within 45 minutes, with rising volume, it usually has real follow-through rather than being a fakeout.'
  };
}

// ---------------- NSE OI enrichment (Nifty) ----------------

// optionGreek endpoint OI nahi deta, isliye NSE se strike-wise OI merge karte hain
const NSE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
let oiCache = { key: null, at: 0, map: null };

function nseExpiryFormat(expiry) { // 07JUL2026 -> 07-Jul-2026
  const m = expiry.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  return m[1] + '-' + m[2][0] + m[2].slice(1).toLowerCase() + '-' + m[3];
}

async function getNSEOI(expiry) {
  const key = 'NIFTY|' + expiry;
  if (oiCache.key === key && Date.now() - oiCache.at < 60000) return oiCache.map;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 9000);
    // cookie warmup
    const home = await fetch('https://www.nseindia.com/option-chain', {
      headers: { 'User-Agent': NSE_UA, 'Accept': 'text/html' }, signal: ctrl.signal
    });
    const cookies = (home.headers.getSetCookie ? home.headers.getSetCookie() : [])
      .map(c => c.split(';')[0]).join('; ');
    const r = await fetch('https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY', {
      headers: { 'User-Agent': NSE_UA, 'Accept': 'application/json', 'Cookie': cookies, 'Referer': 'https://www.nseindia.com/option-chain' },
      signal: ctrl.signal
