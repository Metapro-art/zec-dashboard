// check-zec.js
// Este script corre en GitHub Actions cada 4 horas.
// Analiza ZEC y envia email si las condiciones se cumplen.

const https = require('https');
const nodemailer = require('nodemailer');

const EMAIL_USER     = process.env.EMAIL_USER;
const EMAIL_PASS     = process.env.EMAIL_PASS;
const EMAIL_TO       = process.env.EMAIL_TO;
const MIN_CONDITIONS = parseInt(process.env.MIN_CONDITIONS || '4');

// ---------- Fetch datos ----------
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ---------- Calculos ----------
function calcEMA(arr, p) {
  if (arr.length < p) return arr.map(() => null);
  const k = 2 / (p + 1);
  const result = Array(p - 1).fill(null);
  let ema = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  result.push(ema);
  for (let i = p; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcRSI(arr, p = 14) {
  if (arr.length < p + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= p; i++) {
    const d = arr[i] - arr[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / p, al = losses / p;
  for (let i = p + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function fibLevels(h, l) {
  const r = h - l;
  return {
    0: l, 0.236: l + 0.236 * r, 0.382: l + 0.382 * r,
    0.5: l + 0.5 * r, 0.618: l + 0.618 * r, 0.786: l + 0.786 * r, 1: h
  };
}

function fibExtensions(h, l) {
  const r = h - l;
  return {
    '1.272': (h + 0.272 * r).toFixed(2),
    '1.414': (h + 0.414 * r).toFixed(2),
    '1.618': (h + 0.618 * r).toFixed(2),
    '2.0':   (h + r).toFixed(2),
    '2.618': (h + 1.618 * r).toFixed(2),
  };
}

// ---------- Main ----------
async function main() {
  console.log('Fetching ZEC data...');

  const url = 'https://min-api.cryptocompare.com/data/v2/histoday?fsym=ZEC&tsym=USD&limit=600';
  const json = await fetchJSON(url);

  if (json.Response === 'Error') {
    console.error('API error:', json.Message);
    process.exit(1);
  }

  const data   = json.Data.Data;
  const prices = data.map(d => d.close);
  const vols   = data.map(d => d.volumeto);
  const cur    = prices[prices.length - 1];
  const prev   = prices[prices.length - 2];
  const chg24  = ((cur - prev) / prev * 100).toFixed(2);

  // Ultimos 120 dias para analisis diario
  const p120 = prices.slice(-120);
  const v120 = vols.slice(-120);

  const hi = Math.max(...p120);
  const lo = Math.min(...p120);
  const fibs = fibLevels(hi, lo);
  const exts = fibExtensions(hi, lo);

  // EMAs
  const ema500all = calcEMA(prices, 500);
  const ema500    = ema500all[ema500all.length - 1];
  const ema50arr  = calcEMA(p120, Math.min(50, p120.length - 2));
  const ema50     = ema50arr[ema50arr.length - 1];

  // RSI
  const rsi = calcRSI(p120);

  // Volumen
  const recentVol = v120.slice(-7).reduce((a, b) => a + b, 0) / 7;
  const priorVol  = v120.slice(-14, -7).reduce((a, b) => a + b, 0) / 7;
  const volRatio  = priorVol > 0 ? recentVol / priorVol : 1;

  // Condiciones
  const fibZone    = cur >= fibs[0.382] && cur <= fibs[0.618];
  const aboveEMA50 = ema50 ? cur > ema50 : false;
  const hi30       = Math.max(...p120.slice(-30));
  const belowHi30  = cur < hi30 * 0.95;
  const ema500dist = ema500 ? ((cur - ema500) / ema500 * 100).toFixed(1) : 'N/A';

  const conditions = [
    { label: 'RSI < 45',              ok: rsi !== null && rsi < 45 },
    { label: 'Precio en Fib 0.382-0.618', ok: fibZone },
    { label: 'Volumen creciente',     ok: volRatio >= 1.1 },
    { label: 'Precio sobre EMA 50',   ok: aboveEMA50 },
    { label: 'Bajo 95% max 30d',      ok: belowHi30 },
  ];

  const passing = conditions.filter(c => c.ok).length;
  const total   = conditions.length;

  let signal;
  if (passing >= 5)      signal = 'COMPRA FUERTE';
  else if (passing >= 4) signal = 'Señal de compra';
  else if (passing >= 3) signal = 'Observar';
  else if (passing >= 2) signal = 'Cautela';
  else                   signal = 'Esperar';

  // Reporte en consola
  console.log('=== ZEC ANALISIS ===');
  console.log(`Precio: $${cur.toFixed(2)} (${chg24}% 24h)`);
  console.log(`RSI: ${rsi ? rsi.toFixed(1) : 'N/A'}`);
  console.log(`EMA 500: $${ema500 ? ema500.toFixed(2) : 'N/A'} (${ema500dist}%)`);
  console.log(`Vol ratio: ${volRatio.toFixed(2)}x`);
  console.log(`Señal: ${signal} (${passing} de ${total} condiciones)`);
  conditions.forEach(c => console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}`));

  // Enviar email solo si cumple el minimo
  if (passing >= MIN_CONDITIONS) {
    console.log(`\nCondiciones (${passing}) >= minimo (${MIN_CONDITIONS}). Enviando email...`);

    const targets = Object.entries(exts)
      .map(([r, p]) => `Fib ${r}: $${p}`)
      .join('\n');

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS,   // App Password de Google, NO tu contraseña normal
      }
    });

    const condText = conditions
      .map(c => `${c.ok ? '✓' : '✗'} ${c.label}`)
      .join('\n');

    await transporter.sendMail({
      from:    `"ZEC Alert" <${EMAIL_USER}>`,
      to:      EMAIL_TO,
      subject: `ZEC Alert: ${signal} (${passing} de ${total})`,
      text: `
ZEC ALERT - ${new Date().toLocaleString('es-CO')}

Señal:   ${signal}
Precio:  $${cur.toFixed(2)} (${chg24}% 24h)

INDICADORES
RSI 14:     ${rsi ? rsi.toFixed(1) : 'N/A'}
EMA 500:    $${ema500 ? ema500.toFixed(2) : 'N/A'} (${ema500dist}%)
Vol 7d/7d:  ${volRatio.toFixed(2)}x
Fib soporte: ${Object.entries(fibs).find(([k]) => Math.abs(fibs[k] - cur) < 2)?.[0] ?? 'N/A'}

CONDICIONES ACTIVAS (${passing} de ${total})
${condText}

TARGETS DE SALIDA
${targets}

---
Este email fue generado automaticamente por GitHub Actions.
      `.trim()
    });

    console.log('Email enviado exitosamente.');
  } else {
    console.log(`\nCondiciones (${passing}) < minimo (${MIN_CONDITIONS}). No se envia email.`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
