// check-zec.js — GitHub Actions automated ZEC alert
// Weighted scoring: Macro(3pts) > Momentum(2pts) > Confirma(1pt)
// Matches dashboard v8 indicator logic exactly

const https = require('https');
const nodemailer = require('nodemailer');

const EMAIL_USER     = process.env.EMAIL_USER;
const EMAIL_PASS     = process.env.EMAIL_PASS;   // Google App Password
const EMAIL_TO       = process.env.EMAIL_TO;
// Minimum score PERCENTAGE to trigger email (e.g. 40 = 40% of max weighted score)
const MIN_PCT = parseFloat(process.env.MIN_PCT || process.env.MIN_CONDITIONS || '58');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

/* ── Math (identical to dashboard) ── */
function calcEMA(arr, p) {
  if (!arr || arr.length < p) return (arr||[]).map(()=>null);
  const k = 2/(p+1), r = Array(p-1).fill(null);
  let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p; r.push(e);
  for (let i = p; i < arr.length; i++) { e = arr[i]*k + e*(1-k); r.push(e); }
  return r;
}
function calcRSI(arr, p=14) {
  if (!arr||arr.length<p+1) return (arr||[]).map(()=>null);
  const r=Array(p).fill(null); let g=0,l=0;
  for(let i=1;i<=p;i++){const d=arr[i]-arr[i-1];d>0?g+=d:l-=d;}
  let ag=g/p,al=l/p; r.push(al===0?100:100-100/(1+ag/al));
  for(let i=p+1;i<arr.length;i++){const d=arr[i]-arr[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r.push(al===0?100:100-100/(1+ag/al));}
  return r;
}
function calcMACD(closes) {
  const e12=calcEMA(closes,12),e26=calcEMA(closes,26);
  const macd=e12.map((v,i)=>(v!==null&&e26[i]!==null)?v-e26[i]:null);
  const first=macd.findIndex(v=>v!==null);
  if(first<0)return{macd,signal:macd.map(()=>null),hist:macd.map(()=>null)};
  const signal=[...Array(first).fill(null),...calcEMA(macd.slice(first),9)];
  return{macd,signal,hist:macd.map((v,i)=>(v!==null&&signal[i]!==null)?v-signal[i]:null)};
}
function calcOBV(closes,vols){
  const o=[0];
  for(let i=1;i<closes.length;i++){const p=o[o.length-1];if(closes[i]>closes[i-1])o.push(p+vols[i]);else if(closes[i]<closes[i-1])o.push(p-vols[i]);else o.push(p);}
  return o;
}
function linregSlope(arr,n=14){
  const r=arr.slice(-n),len=r.length;if(len<2)return 0;
  const sx=len*(len-1)/2,sy=r.reduce((a,b)=>a+b,0),sxy=r.reduce((a,v,i)=>a+i*v,0),sx2=len*(len-1)*(2*len-1)/6;
  const d=len*sx2-sx*sx;return d===0?0:(len*sxy-sx*sy)/d;
}
function linregSlope(arr,n=14){
  const r=arr.slice(-n),len=r.length;if(len<2)return 0;
  const sx=len*(len-1)/2,sy=r.reduce((a,b)=>a+b,0),sxy=r.reduce((a,v,i)=>a+i*v,0),sx2=len*(len-1)*(2*len-1)/6;
  const d=len*sx2-sx*sx;return d===0?0:(len*sxy-sx*sy)/d;
}
function detectDiv(prices,rsiArr){
  const rC=rsiArr.map(v=>v??50),pS=prices.slice(-60),rS=rC.slice(-60);
  const sl=[];for(let i=3;i<pS.length-3;i++){let ok=true;for(let j=1;j<=3;j++)if(pS[i]>=pS[i-j]||pS[i]>=pS[i+j]){ok=false;break;}if(ok)sl.push(i);}
  if(sl.length>=2){const[a,b]=sl.slice(-2);if(pS[b]<pS[a]&&rS[b]>rS[a])return'bullish';}
  return null;
}
function fibL(h,l){const r=h-l;return{0:l,.236:l+.236*r,.382:l+.382*r,.5:l+.5*r,.618:l+.618*r,.786:l+.786*r,1:h};}
function fibE(h,l){const r=h-l;return{'1.272':h+.272*r,'1.414':h+.414*r,'1.618':h+.618*r,'2.0':h+r,'2.618':h+1.618*r};}
function aggWeekly(data){
  const closes=[],vols=[],highs=[],lows=[];
  for(let i=6;i<data.length;i+=7){const sl=data.slice(i-6,i+1);closes.push(sl[sl.length-1].close);highs.push(Math.max(...sl.map(d=>d.high)));lows.push(Math.min(...sl.map(d=>d.low)));vols.push(sl.reduce((a,b)=>a+b.volumeto,0));}
  return{closes,highs,lows,vols};
}

/* ── Halving phase ── */
const ZEC_HALVING2 = new Date('2024-11-18');
const ZEC_HALVING3 = new Date('2028-11-01');
function getHalvingPhase() {
  const days = Math.floor((new Date() - ZEC_HALVING2) / (1000*60*60*24));
  if (days < 180) return { phase: 'Corrección post-halving', key: 'correction', days };
  if (days < 540) return { phase: 'Acumulación institucional ✓', key: 'accumulation', days };
  if (days < 900) return { phase: 'Bull run', key: 'bull', days };
  if (days < 1260) return { phase: 'Techo de ciclo', key: 'top', days };
  return { phase: 'Bear market', key: 'bear', days };
}

/* ── Weighted scoring v2 — 8 independent dimensions, 16pt max ── */
function buildScore(params) {
  const { rsiD, rsiW, cur, e200c, volR, macdAbove, macdBullish, obvRising,
          div, fibZone, peakFib618, peakFib786, halvPhase,
          wObvRising, e500d } = params;

  /* TIMING — best of 3 momentum signals */
  const macdBullSignal = macdBullish === true;
  const rsiOversoldDiv = div === 'bullish';
  const rsiBoth        = rsiD!==null&&rsiD<45 && rsiW!==null&&rsiW<45;
  const timingActive   = macdBullSignal || rsiOversoldDiv || rsiBoth;
  const timingDetail   = macdBullSignal ? 'MACD cruce alcista bajo cero ★'
                       : rsiOversoldDiv ? 'Divergencia alcista RSI'
                       : rsiBoth        ? 'RSI diario y semanal ambos < 45'
                       : 'Ninguna';

  /* CICLO — price not extended */
  const notExtended = (rsiD===null||rsiD<70) && ((e500d||0)<60);

  const conds = [
    /* MACRO (7pt max) */
    { cat:'Macro',  l:'Fase de acumulación post-halving',          w:3, ok: halvPhase==='accumulation' },
    { cat:'Macro',  l:'Precio sobre EMA 200 semanal',              w:2, ok: e200c ? cur>e200c : false },
    { cat:'Macro',  l:'Zona Last Peak Fib (0.618–0.786)',          w:2, ok: peakFib618||peakFib786 },
    /* CICLO (4pt max) */
    { cat:'Ciclo',  l:'Precio NO extendido (RSI<70, EMA500<60%)',  w:2, ok: notExtended },
    { cat:'Ciclo',  l:'Soporte Fib 60d (0.382–0.618)',             w:2, ok: fibZone },
    /* FLUJO (4pt max) */
    { cat:'Flujo',  l:'OBV alcista en diario Y semanal',           w:2, ok: obvRising && wObvRising },
    { cat:'Flujo',  l:'Volumen creciente (ratio ≥ 1.2)',           w:2, ok: volR>=1.2 },
    /* TIMING (1pt max) */
    { cat:'Timing', l:`Señal de momentum: ${timingDetail}`,        w:1, ok: timingActive },
  ];

  const earned = conds.reduce((a,c)=>a+(c.ok?c.w:0), 0);
  const max    = conds.reduce((a,c)=>a+c.w, 0);
  const pct    = max>0 ? earned/max : 0;

  /* Extension cap — same logic as dashboard */
  const veryExtended = rsiD>70 && (e500d||0)>60;
  const extended     = rsiD>65 || (e500d||0)>60;

  let signal, extNote='';
  if (veryExtended) {
    signal='Cautela (precio extendido)';
    extNote=`⚠ RSI ${rsiD?.toFixed(1)} en sobrecompra + ${(e500d||0).toFixed(0)}% sobre EMA 500. Señal estructural válida pero PRECIO MUY EXTENDIDO — no entrar. Esperar retroceso.`;
  } else if (extended) {
    const rawSig = pct>=.68?'Compra fuerte':pct>=.56?'Señal de compra':pct>=.38?'Observar':pct>=.22?'Cautela':'Esperar';
    signal=(rawSig==='Compra fuerte'||rawSig==='Señal de compra') ? 'Observar (precio extendido)' : rawSig;
    extNote=`${rsiD>65?`RSI ${rsiD?.toFixed(1)} zona alta. `:''}${(e500d||0)>60?`Precio ${(e500d||0).toFixed(0)}% sobre EMA 500. `:''}Señal rebajada — mejor entrada en pullback.`;
  } else {
    if      (pct>=.68) signal='COMPRA FUERTE';
    else if (pct>=.56) signal='Señal de compra';
    else if (pct>=.38) signal='Observar';
    else if (pct>=.22) signal='Cautela';
    else               signal='Esperar';
  }
  return { earned, max, pct, signal, conds, extNote, timingDetail };
}

/* ── Main ── */
async function main() {
  console.log(`[${new Date().toISOString()}] Analizando ZEC...`);

  const json = await fetchJSON('https://min-api.cryptocompare.com/data/v2/histoday?fsym=ZEC&tsym=USD&limit=2000');
  if (json.Response==='Error') throw new Error('API: '+json.Message);
  const data = json.Data.Data;
  const allC = data.map(d=>d.close);

  // Live price
  let curPrice = allC[allC.length-1], chg24='—';
  try {
    const lj = await fetchJSON('https://min-api.cryptocompare.com/data/pricemultifull?fsyms=ZEC,BTC&tsyms=USD');
    const zec=lj.RAW?.ZEC?.USD; const btc=lj.RAW?.BTC?.USD;
    if(zec){ curPrice=zec.PRICE; chg24=(zec.CHANGEPCT24HOUR>=0?'+':'')+zec.CHANGEPCT24HOUR.toFixed(2)+'%'; }
  } catch { console.log('Live price fallback'); }

  // EMA 500
  const e500all = calcEMA(allC, 500);
  const e500c   = e500all[e500all.length-1];
  const e500d   = e500c ? ((curPrice-e500c)/e500c*100).toFixed(1)+'%' : 'N/A';

  // Daily (120 days)
  const dS   = data.slice(-120);
  const dc   = dS.map(d=>d.close), dv=dS.map(d=>d.volumeto);
  const dRsi = calcRSI(dc); const dRsiC=dRsi[dRsi.length-1];
  const dE50 = calcEMA(dc,50); const dE50c=dE50[dE50.length-1];
  const dVr  = (dv.slice(-7).reduce((a,b)=>a+b,0)/7) / ((dv.slice(-14,-7).reduce((a,b)=>a+b,0)/7)||1);
  const dMacd = calcMACD(dc);
  const dMacdC=dMacd.macd[dMacd.macd.length-1], dSigC=dMacd.signal[dMacd.signal.length-1];
  const dMacdAbove = dMacdC!==null&&dSigC!==null&&dMacdC>dSigC;
  const dMacdPrev  = dMacd.macd[dMacd.macd.length-2], dSigPrev=dMacd.signal[dMacd.signal.length-2];
  const dMacdBull  = dMacdAbove && dMacdPrev!==null&&dSigPrev!==null&&dMacdPrev<=dSigPrev && dMacdC<0;
  const dObv = calcOBV(dc,dv); const dObvRising=linregSlope(dObv,14)>0;
  const dDiv = detectDiv(dc,dRsi);

  // Weekly
  const wData  = aggWeekly(data);
  const wc=wData.closes, wv=wData.vols;
  const wRsi   = calcRSI(wc); const wRsiC=wRsi[wRsi.length-1];
  const wE20   = calcEMA(wc,Math.min(20,wc.length-2)); const wE20c=wE20[wE20.length-1];
  const wE200  = calcEMA(wc,Math.min(200,wc.length-2)); const wE200c=wE200[wE200.length-1];
  const wVr    = (wv.slice(-4).reduce((a,b)=>a+b,0)/4) / ((wv.slice(-8,-4).reduce((a,b)=>a+b,0)/4)||1);
  const wMacd  = calcMACD(wc);
  const wMacdC=wMacd.macd[wMacd.macd.length-1], wSigC=wMacd.signal[wMacd.signal.length-1];
  const wMacdAbove = wMacdC!==null&&wSigC!==null&&wMacdC>wSigC;
  const wMacdPrev  = wMacd.macd[wMacd.macd.length-2], wSigPrev=wMacd.signal[wMacd.signal.length-2];
  const wMacdBull  = wMacdAbove && wMacdPrev!==null&&wSigPrev!==null&&wMacdPrev<=wSigPrev && wMacdC<0;
  const wObv   = calcOBV(wc,wv); const wObvRising=linregSlope(wObv,10)>0;
  const wDiv   = detectDiv(wc,wRsi);

  // Fibonacci (60d)
  const fS   = data.slice(-60);
  const fibHi= Math.max(...fS.map(d=>d.high)), fibLo=Math.min(...fS.map(d=>d.low));
  const fibs = fibL(fibHi,fibLo);
  const exts = fibE(fibHi,fibLo);
  const fibZone = curPrice>=fibs[.382] && curPrice<=fibs[.618];
  const hi30    = Math.max(...data.slice(-30).map(d=>d.high));
  const belowHi = curPrice < hi30*.95;
  const nFib    = [0,.236,.382,.5,.618,.786,1].reduce((b,r)=>Math.abs(fibs[r]-curPrice)<Math.abs(fibs[b]-curPrice)?r:b,0);

  // Last Peak macro fibs
  const PEAK_LO=55.78, PEAK_HI=698.33;
  const pkFibs = fibL(PEAK_HI,PEAK_LO);
  const pkExts = fibE(PEAK_HI,PEAK_LO);
  const peakFib618 = curPrice>=pkFibs[.618]*.97 && curPrice<=pkFibs[.618]*1.03;
  const peakFib786 = curPrice>=pkFibs[.786]*.97 && curPrice<=pkFibs[.786]*1.03;

  // Halving
  const halv = getHalvingPhase();

  // OBV divergence detection (same logic as dashboard)
  const DIV_WINDOW=20;
  const dPriceLast=dc.slice(-DIV_WINDOW);
  const dObvLast=dObv.slice(-DIV_WINDOW);
  const dPriceSlope=linregSlope(dPriceLast,DIV_WINDOW);
  const dObvSlope2=linregSlope(dObvLast,DIV_WINDOW);
  const obvBullDiv=dPriceSlope<0&&dObvSlope2>0;
  const obvBearDiv=dPriceSlope>0&&dObvSlope2<0;
  const obvDivText=obvBullDiv?'DIVERGENCIA ALCISTA ★ (precio baja, OBV sube)':
                   obvBearDiv?'DIVERGENCIA BAJISTA ⚠ (precio sube, OBV baja)':
                   'Sin divergencia';

  // Score
  const e500dVal = e500c ? ((curPrice-e500c)/e500c*100) : 0;

  // ═══ DCA MODE & DIP DETECTION ═══
  const dcaModeActive = halv.key==='accumulation' && wE200c && curPrice>wE200c && halv.days>90;
  const hi14 = Math.max(...dc.slice(-14));
  const dropFromHi14 = ((curPrice-hi14)/hi14)*100;
  const rsi14ago = dRsiArr[dRsiArr.length-15];
  const dipDrop8 = dropFromHi14 <= -8;
  const dipRsiSwing = rsi14ago>55 && dRsiC<45;
  const dipRsiOversold = dRsiC!==null && dRsiC<35;
  const dipFibSupport = fibZone || peakFib618 || peakFib786;

  const dipSignals = [];
  if (dipDrop8)        dipSignals.push({l:`Caída del ${dropFromHi14.toFixed(1)}% desde máx 14d`, w:2});
  if (dipRsiSwing)     dipSignals.push({l:`RSI bajó de ${rsi14ago?.toFixed(0)} a ${dRsiC?.toFixed(0)} en 14d`, w:2});
  if (dipRsiOversold)  dipSignals.push({l:`RSI sobreventa profunda (${dRsiC?.toFixed(0)})`, w:3});
  if (dipFibSupport)   dipSignals.push({l: peakFib618?'Fib 0.618 macro ★★':peakFib786?'Fib 0.786 macro ★':'Fib 0.382–0.618 corto plazo', w: peakFib618||peakFib786?3:2});

  const dipScore = dipSignals.reduce((a,s)=>a+s.w, 0);
  const dipActive = dcaModeActive && dipScore>=2;
  let dcaTier = null;
  if (dipActive) {
    if (dipScore>=5) dcaTier = {l:'CAÍDA FUERTE', pct:'25–35%', note:'Múltiples señales — comprar tramo grande'};
    else if (dipScore>=3) dcaTier = {l:'CAÍDA BUENA', pct:'15–20%', note:'Buena oportunidad — tramo medio'};
    else dcaTier = {l:'CAÍDA LEVE', pct:'8–12%', note:'Caída pequeña — tramo pequeño'};
  }

  const score = buildScore({
    rsiD:dRsiC, rsiW:wRsiC, cur:curPrice, e200c:wE200c,
    volR:dVr, macdAbove:dMacdAbove, macdBullish:dMacdBull,
    obvRising:dObvRising, wObvRising,
    div:dDiv, fibZone,
    peakFib618, peakFib786, halvPhase:halv.key,
    e500d:e500dVal
  });

  // Weekly score (using weekly-derived data) for confluence display
  const wScore = buildScore({
    rsiD:wRsiC, rsiW:wRsiC, cur:curPrice, e200c:wE200c,
    volR:wVr, macdAbove:wMacdAbove, macdBullish:wMacdBull,
    obvRising:wObvRising, wObvRising,
    div:wDiv, fibZone,
    peakFib618, peakFib786, halvPhase:halv.key,
    e500d:e500dVal
  });

  const confPct = Math.round(((score.pct+wScore.pct)/2)*100);

  // Market cap estimate
  const ZEC_SUPPLY = 16_800_000;
  const zecMcap = curPrice * ZEC_SUPPLY;

  // Console report
  console.log('\n══════════════════════════════════');
  console.log(`Precio: $${curPrice.toFixed(2)} (${chg24})`);
  console.log(`EMA 500: $${e500c?.toFixed(2)} (${e500d})`);
  console.log(`EMA 200 semanal: $${wE200c?.toFixed(2)}`);
  console.log(`\nSEÑAL: ${score.signal} (${score.earned}/${score.max} pts = ${Math.round(score.pct*100)}%)`);
  console.log(`Confluencia D+S: ${confPct}%`);
  console.log(`\nHalving: ${halv.phase} (${halv.days} días desde nov 2024)`);
  console.log(`Last Peak Fib 0.618: $${pkFibs[.618].toFixed(2)} | 0.786: $${pkFibs[.786].toFixed(2)}`);
  console.log('\nCONDICIONES:');
  score.conds.forEach(c=>console.log(`  ${c.ok?'✓':'✗'} [${c.w}pt] ${c.l}`));
  console.log('\nINDICADORES:');
  console.log(`  RSI diario: ${dRsiC?.toFixed(1)} | RSI semanal: ${wRsiC?.toFixed(1)}`);
  console.log(`  MACD diario: ${dMacdAbove?'↑':'↓'}${dMacdBull?' (cruce bajo cero ★)':''}`);
  console.log(`  MACD semanal: ${wMacdAbove?'↑':'↓'}${wMacdBull?' (cruce bajo cero ★)':''}`);
  console.log(`  OBV diario: ${dObvRising?'Acumulación ↑':'Distribución ↓'} | Semanal: ${wObvRising?'↑':'↓'}`);
  console.log(`  Div RSI: ${dDiv||'Ninguna'}`);
  console.log(`  Fib (60d): cercano a ${nFib} | En zona: ${fibZone?'Sí':'No'}`);

  // ═══ SELL STRATEGY · STRICT CYCLE TOP MODE ═══
  // All 3 conditions must be met simultaneously
  const inTopPhase = halv.key === 'top';
  const fib1618 = pkExts['1.618'] || null;
  const inHighExt = fib1618 !== null && curPrice >= fib1618 * 0.97;
  const wRsiHot = wRsiC !== null && wRsiC > 70;
  const sellModeActive = inTopPhase && inHighExt && wRsiHot;
  const sellInTopButWaiting = inTopPhase && !sellModeActive;

  // Send if score threshold met OR DCA dip is active OR sell mode activates
  const trigger = score.pct * 100;
  const shouldSendNormal = trigger >= MIN_PCT;
  const shouldSendDip = dipActive;
  const shouldSendSell = sellModeActive;
  const shouldSend = shouldSendNormal || shouldSendDip || shouldSendSell;

  if (shouldSend) {
    const reasons = [];
    if (shouldSendNormal) reasons.push(`Score ${trigger.toFixed(0)}% >= ${MIN_PCT}%`);
    if (shouldSendDip)    reasons.push(`DIP ${dcaTier.l}`);
    if (shouldSendSell)   reasons.push(`★ ZONA DE VENTA · techo de ciclo`);
    const triggerReason = reasons.join(' + ');
    console.log(`\n→ Trigger: ${triggerReason} — enviando email...`);

    const condText = score.conds.map(c=>`${c.ok?'✓':'✗'} [${c.w}pt] ${c.l}`).join('\n');
    const targetsText = Object.entries(exts).map(([r,p])=>`  Fib ${r}: $${p.toFixed(2)} (+${((p-curPrice)/curPrice*100).toFixed(0)}%)`).join('\n');

    /* SELL section */
    let sellSection = '';
    if (sellModeActive) {
      // Use anchor from env if set, else current price (GitHub Actions can't read browser localStorage)
      const sellAnchor = parseFloat(process.env.DCA_ANCHOR) || curPrice;
      sellSection = `\n━━━ ★ ESTRATEGIA DE SALIDA ACTIVA ━━\n`;
      sellSection += `TECHO DE CICLO CONFIRMADO — ejecutar plan asimétrico\n`;
      sellSection += `\n3 condiciones cumplidas:\n`;
      sellSection += `  ✓ Fase: ${halv.phase} (día ${halv.days} post-halving)\n`;
      sellSection += `  ✓ Precio en Fib 1.618+ ($${fib1618.toFixed(2)})\n`;
      sellSection += `  ✓ RSI semanal sobrecompra (${wRsiC.toFixed(1)})\n`;
      sellSection += `\nNiveles de venta (% de tu posición):\n`;
      const sellLvls = [
        {l:'Nivel 1 — +50% del ancla',  p:sellAnchor*1.50, pct:10},
        {l:'Nivel 2 — +100% del ancla', p:sellAnchor*2.00, pct:20},
        {l:'Nivel 3 — +200% del ancla', p:sellAnchor*3.00, pct:30},
        {l:'Nivel 4 — +400% del ancla', p:sellAnchor*5.00, pct:25},
      ];
      sellLvls.forEach(lv => {
        const dist = ((curPrice-lv.p)/lv.p*100);
        const reached = curPrice >= lv.p;
        sellSection += `  ${reached?'✓':' '} ${lv.l}: $${lv.p.toFixed(2)} (${dist>=0?'+':''}${dist.toFixed(1)}%) — vender ${lv.pct}%\n`;
      });
      sellSection += `\n  ★ CORE: 15% holding permanente (siguiente ciclo halving 2028)\n`;
    } else if (sellInTopButWaiting) {
      sellSection = `\n━━━ ZONA DE TECHO · ESPERANDO CONFLUENCIA ━━\n`;
      sellSection += `Estás en fase de techo (día ${halv.days}) pero faltan condiciones:\n`;
      sellSection += `  ${inHighExt?'✓':'✗'} Fib 1.618 alcanzado${fib1618?` (= $${fib1618.toFixed(2)})`:''}\n`;
      sellSection += `  ${wRsiHot?'✓':'✗'} RSI semanal > 70 (actual: ${wRsiC?.toFixed(1)||'—'})\n`;
      sellSection += `Sin las 3, NO vender.\n`;
    }

    /* DCA section */
    let dcaSection = '';
    if (dcaModeActive) {
      dcaSection = `\n━━━ MODO ACUMULACIÓN DCA ━━━━━\n`;
      dcaSection += `Estamos en fase de acumulación post-halving (día ${halv.days}).\n`;
      dcaSection += `Estrategia: comprar caídas en tramos, no esperar bottom único.\n`;
      if (dipActive) {
        dcaSection += `\n⬇ DIP DETECTADO: ${dcaTier.l}\n`;
        dcaSection += `${dcaTier.note} (sugerencia: ${dcaTier.pct} del capital DCA)\n`;
        dcaSection += `\nSeñales detectadas:\n`;
        dipSignals.forEach(s => dcaSection += `  • ${s.l}\n`);
      } else {
        dcaSection += `Sin dip activo en este momento.\n`;
      }
      const lvls = [
        {l:'Nivel 1 — Precio actual',  p:curPrice,        pct:15},
        {l:'Nivel 2 — Caída del 10%',  p:curPrice*0.90,   pct:20},
        {l:'Nivel 3 — Caída del 20%',  p:curPrice*0.80,   pct:30},
        {l:'Nivel 4 — Caída del 30%',  p:curPrice*0.70,   pct:35},
      ];
      dcaSection += `\nNiveles DCA recomendados (% del capital total):\n`;
      lvls.forEach(lv => {
        const dist = ((curPrice-lv.p)/lv.p*100);
        const reached = curPrice <= lv.p*1.03;
        dcaSection += `  ${reached?'✓':' '} ${lv.l}: $${lv.p.toFixed(2)} (${dist>=0?'+':''}${dist.toFixed(1)}%) — ${lv.pct}%\n`;
      });
    }

    const body = `
ZEC ALERT — ${new Date().toLocaleString('es-CO')}
${shouldSendDip&&!shouldSendNormal?'\n⬇ ALERTA DE DIP — comprable según estrategia DCA\n':''}${shouldSendSell?'\n★ ZONA DE VENTA · TECHO DE CICLO ACTIVO — ejecutar plan de salida asimétrico\n':''}
━━━ SEÑAL PONDERADA ━━━━━━━━━━━
${score.signal}
${score.earned}/${score.max} pts (${Math.round(score.pct*100)}% del máximo posible)
Confluencia D+S: ${confPct}%
${score.extNote?'\n⚠ '+score.extNote:''}
━━━ CONTEXTO DE ENTRADA ━━━━━━━
RSI diario ${dRsiC?.toFixed(1)} ${dRsiC>70?'— SOBRECOMPRA, no entrar ahora':dRsiC>65?'— elevado, precaución':dRsiC<30?'— SOBREVENTA, zona óptima':dRsiC<45?'— zona de compra ✓':'— neutral'}
EMA 500: ${e500dVal.toFixed(1)}% ${e500dVal>60?'— MUY EXTENDIDO, esperar pullback':e500dVal>30?'— extendido':e500dVal>0?'— tendencia alcista ✓':'— bajo EMA 500'}

━━━ PRECIO ━━━━━━━━━━━━━━━━━━━━
Precio actual:   $${curPrice.toFixed(2)} (${chg24})
EMA 500:         $${e500c?.toFixed(2)} (${e500d})
EMA 200 semanal: $${wE200c?.toFixed(2)} ${wE200c&&curPrice>wE200c?'(precio sobre ella ✓)':'(precio bajo ella)'}
ZEC Market Cap:  $${(zecMcap/1e6).toFixed(0)}M

━━━ CICLO HALVING ━━━━━━━━━━━━━
${halv.phase}
${halv.days} días desde halving Nov 2024
${dcaSection}${sellSection}
━━━ MACRO — LAST PEAK ━━━━━━━━
Ciclo: $${PEAK_LO} (sep 2025) → $${PEAK_HI} (nov 2025)
Fib 0.382: $${pkFibs[.382].toFixed(2)}
Fib 0.618: $${pkFibs[.618].toFixed(2)} ★★ ${peakFib618?'← PRECIO AQUÍ':''}
Fib 0.786: $${pkFibs[.786].toFixed(2)} ★  ${peakFib786?'← PRECIO AQUÍ':''}

━━━ FIBONACCI (60d) ━━━━━━━━━━━
Alto: $${fibHi.toFixed(2)} | Bajo: $${fibLo.toFixed(2)}
Nivel cercano: Fib ${nFib}
En zona 0.382-0.618: ${fibZone?'Sí ✓':'No'}

━━━ TARGETS DE SALIDA ━━━━━━━━
${targetsText}

━━━ INDICADORES DIARIO ━━━━━━━
RSI 14:   ${dRsiC?.toFixed(1)} ${dRsiC<30?'(SOBREVENTA)':dRsiC<45?'(zona compra)':''}
MACD:     ${dMacdAbove?'Sobre señal ↑':'Bajo señal ↓'}${dMacdBull?' ★ CRUCE BAJO CERO':''}
OBV:      ${dObvRising?'Acumulación ↑':'Distribución ↓'}
OBV DIV:  ${obvDivText}
Div RSI:  ${dDiv||'Ninguna'}

━━━ INDICADORES SEMANAL ━━━━━━
RSI:      ${wRsiC?.toFixed(1)}
MACD:     ${wMacdAbove?'Sobre señal ↑':'Bajo señal ↓'}${wMacdBull?' ★ CRUCE BAJO CERO':''}
OBV:      ${wObvRising?'Acumulación ↑':'Distribución ↓'}

━━━ CONDICIONES PONDERADAS ━━━━
${condText}

---
GitHub Actions · check-zec.js
Señal al ${MIN_PCT}% del score máximo
`.trim();

    const transporter = nodemailer.createTransport({ service:'gmail', auth:{user:EMAIL_USER,pass:EMAIL_PASS} });
    await transporter.sendMail({
      from: `"ZEC Alert" <${EMAIL_USER}>`,
      to: EMAIL_TO,
      subject: `ZEC: ${sellModeActive?'★ ZONA VENTA · ':''}${score.signal} | ${Math.round(score.pct*100)}% | Conf ${confPct}% | $${curPrice.toFixed(2)}${obvBullDiv?' | ★ OBV DIV ALCISTA':obvBearDiv?' | ⚠ OBV DIV BAJISTA':''}`,
      text: body
    });
    console.log('✓ Email enviado.');
  } else {
    console.log(`\n→ Score ${trigger.toFixed(0)}% < mínimo ${MIN_PCT}%. No se envía.`);
  }
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
