module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const out = {};
  const log = [];

  // ── 1. CBOT via stooq.com ──────────────────────────────
  const stooqSymbols = [
    { sym: 'zs.f', id: 'sojaI',  factor: 36.744 / 100 },
    { sym: 'zc.f', id: 'maizI',  factor: 39.368 / 100 },
    { sym: 'zw.f', id: 'trigoI', factor: 36.744 / 100 },
    { sym: 'zl.f', id: '_zl',    factor: 1 },
  ];
  for (const { sym, id, factor } of stooqSymbols) {
    try {
      const r = await fetch('https://stooq.com/q/l/?s=' + sym + '&f=sd2t2ohlcv&h&e=csv', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) { log.push('stooq/' + sym + ': HTTP ' + r.status); continue; }
      const lines = (await r.text()).trim().split('\n');
      if (lines.length < 2) { log.push('stooq/' + sym + ': vacio'); continue; }
      const close = parseFloat(lines[1].split(',')[6]);
      if (!close || close <= 0) { log.push('stooq/' + sym + ': precio invalido'); continue; }
      if (id === '_zl') {
        const zlTon = close * 2204.62 / 100;
        out.aSC = Math.round(zlTon * 1.00);
        out.aSR = Math.round(zlTon * 1.04);
        out.aMC = Math.round(zlTon * 0.88);
        out.aMR = Math.round(zlTon * 0.92);
        out.aGC = Math.round(zlTon * 1.15);
        out.aGR = Math.round(zlTon * 1.20);
        log.push('stooq/zl.f: OK close=' + close);
      } else {
        out[id] = Math.round(close * factor);
        log.push('stooq/' + sym + ': OK ' + out[id]);
      }
    } catch (e) { log.push('stooq/' + sym + ': ' + e.message); }
  }

  // ── 2. Dolar Divisa BNA ────────────────────────────────
  // Intento A: endpoint directo /dolares/divisas
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares/divisas', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    const txt = await r.text();
    log.push('dolarapi/divisas status=' + r.status + ' body=' + txt.slice(0, 200));
    if (r.ok) {
      const d = JSON.parse(txt);
      if (d && d.venta > 0) {
        out.divisa_sell = d.venta;
        out.divisa_buy  = d.compra || d.venta;
        log.push('dolarapi/divisas OK: ' + d.venta);
      }
    }
  } catch (e) { log.push('dolarapi/divisas err: ' + e.message); }

  // Intento B: lista completa y filtrar
  if (!out.divisa_sell) {
    try {
      const r = await fetch('https://dolarapi.com/v1/dolares', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      const txt = await r.text();
      log.push('dolarapi/lista status=' + r.status + ' body=' + txt.slice(0, 400));
      if (r.ok) {
        const data = JSON.parse(txt);
        // Mostrar todas las casas disponibles
        log.push('casas: ' + data.map(function(d){ return d.casa; }).join(', '));
        const divisa = data.find(function(d) {
          const c = (d.casa || '').toLowerCase();
          return c === 'divisas' || c === 'divisa' || c.includes('divis');
        });
        if (divisa && divisa.venta > 0) {
          out.divisa_sell = divisa.venta;
          out.divisa_buy  = divisa.compra || divisa.venta;
          log.push('dolarapi lista/divisa OK: ' + divisa.venta);
        } else {
          log.push('dolarapi lista: divisa no encontrada entre: ' + data.map(function(d){ return d.casa; }).join(', '));
        }
      }
    } catch (e) { log.push('dolarapi/lista err: ' + e.message); }
  }

  // Intento C: argentinadatos
  if (!out.divisa_sell) {
    try {
      const r = await fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (r.ok) {
        const data = await r.json();
        log.push('argentinadatos casas: ' + data.map(function(d){ return d.casa; }).join(', '));
        const divisa = data.find(function(d) {
          return (d.casa || '').toLowerCase().includes('divis');
        });
        if (divisa && divisa.venta > 0) {
          out.divisa_sell = divisa.venta;
          out.divisa_buy  = divisa.compra || divisa.venta;
          log.push('argentinadatos divisa OK: ' + divisa.venta);
        }
      }
    } catch (e) { log.push('argentinadatos err: ' + e.message); }
  }

  // ── 3. Expeller ────────────────────────────────────────
  try {
    const r = await fetch('http://www.expeller.com.ar/pizarra.asp', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-AR,es;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(12000)
    });
    log.push('expeller status=' + r.status);
    if (r.ok) {
      const html = await r.text();
      log.push('expeller html len=' + html.length + ' snippet=' + html.slice(0, 300).replace(/\n/g,' '));
      const findPrice = function(keyword) {
        const lower = html.toLowerCase();
        const idx = lower.indexOf(keyword.toLowerCase());
        if (idx === -1) return null;
        const chunk = html.slice(Math.max(0, idx-100), idx + 1000);
        const nums = chunk.match(/\b(\d{4,7})\b/g);
        if (!nums) return null;
        for (var i = 0; i < nums.length; i++) {
          const v = parseInt(nums[i], 10);
          if (v >= 10000 && v <= 9999999) return v;
        }
        return null;
      };
      const expSoja    = findPrice('soja');
      const expGirasol = findPrice('girasol');
      log.push('expeller soja=' + expSoja + ' girasol=' + expGirasol);
      if (expSoja)    out.expSoja    = expSoja;
      if (expGirasol) out.expGirasol = expGirasol;
    }
  } catch (e) { log.push('expeller err: ' + e.message); }

  // ── 4. Granos BCR ──────────────────────────────────────
  try {
    const r = await fetch('https://www.bcr.com.ar/es/mercados/cotizaciones/granos', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(10000)
    });
    if (r.ok) {
      const html = await r.text();
      const extract = function(pattern) {
        const re = new RegExp(pattern + '[\\s\\S]{0,400}?>(\\d{2,4}(?:[,.]\\d{1,2})?)<', 'i');
        const m = html.match(re);
        if (!m) return null;
        const v = parseFloat(m[1].replace(',', '.'));
        return (v > 50 && v < 2000) ? v : null;
      };
      const s = extract('Soja');
      const m = extract('Ma');
      const g = extract('Girasol');
      if (s) out.gS = s;
      if (m) out.gM = m;
      if (g) out.gG = g;
      log.push('BCR: gS=' + s + ' gM=' + m + ' gG=' + g);
    } else { log.push('BCR HTTP ' + r.status); }
  } catch (e) { log.push('BCR err: ' + e.message); }

  // ── 5. Fallback granos ────────────────────────────────
  if (!out.gS && out.sojaI)  out.gS = Math.round(out.sojaI  * 0.88);
  if (!out.gM && out.maizI)  out.gM = Math.round(out.maizI  * 0.90);
  if (!out.gG && out.trigoI) out.gG = Math.round(out.trigoI * 0.92);

  return res.status(200).json({
    precios: out,
    ts: new Date().toISOString(),
    debug: log
  });
};
