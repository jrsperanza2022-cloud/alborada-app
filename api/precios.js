module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const out = {};
  const errors = [];

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
      if (!r.ok) { errors.push('stooq/' + sym + ' HTTP ' + r.status); continue; }
      const lines = (await r.text()).trim().split('\n');
      if (lines.length < 2) { errors.push('stooq/' + sym + ' vacio'); continue; }
      const close = parseFloat(lines[1].split(',')[6]);
      if (!close || close <= 0) { errors.push('stooq/' + sym + ' sin precio'); continue; }
      if (id === '_zl') {
        const zlTon = close * 2204.62 / 100;
        out.aSC = Math.round(zlTon * 1.00);
        out.aSR = Math.round(zlTon * 1.04);
        out.aMC = Math.round(zlTon * 0.88);
        out.aMR = Math.round(zlTon * 0.92);
        out.aGC = Math.round(zlTon * 1.15);
        out.aGR = Math.round(zlTon * 1.20);
      } else {
        out[id] = Math.round(close * factor);
      }
    } catch (e) { errors.push('stooq/' + sym + ': ' + e.message); }
  }

  // ── 2. Dolar Divisa BNA via Ambito ─────────────────────
  try {
    const r = await fetch('https://mercados.ambito.com/dolar/divisa/variacion', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://www.ambito.com/',
      },
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const d = await r.json();
      // Ambito devuelve { compra: "1.385,00", venta: "1.435,00", ... }
      const sell = parseFloat((d.venta || '').toString().replace(/\./g, '').replace(',', '.'));
      const buy  = parseFloat((d.compra || '').toString().replace(/\./g, '').replace(',', '.'));
      if (sell > 500 && sell < 9999) {
        out.divisa_sell = sell;
        out.divisa_buy  = buy || sell;
      } else {
        errors.push('ambito divisa: valor invalido ' + JSON.stringify(d).slice(0, 100));
      }
    } else {
      errors.push('ambito divisa HTTP ' + r.status);
    }
  } catch (e) { errors.push('ambito divisa: ' + e.message); }

  // Fallback divisa: argentinadatos endpoint especifico
  if (!out.divisa_sell) {
    try {
      const r = await fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares/divisa', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (r.ok) {
        const data = await r.json();
        const last = Array.isArray(data) ? data[data.length - 1] : data;
        if (last && last.venta > 0) {
          out.divisa_sell = last.venta;
          out.divisa_buy  = last.compra || last.venta;
        } else {
          errors.push('argentinadatos divisa: sin datos validos');
        }
      } else {
        errors.push('argentinadatos divisa HTTP ' + r.status);
      }
    } catch (e) { errors.push('argentinadatos divisa: ' + e.message); }
  }

  // ── 3. Expeller via corsproxy.io ───────────────────────
  try {
    const r = await fetch('https://corsproxy.io/?http%3A%2F%2Fwww.expeller.com.ar%2Fpizarra.asp', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(12000)
    });
    if (r.ok) {
      const html = await r.text();
      const findPrice = function(keyword) {
        const lower = html.toLowerCase();
        const idx = lower.indexOf(keyword.toLowerCase());
        if (idx === -1) return null;
        const chunk = html.slice(Math.max(0, idx - 50), idx + 800);
        const nums = chunk.match(/\b\d{4,7}\b/g);
        if (!nums) return null;
        for (var i = 0; i < nums.length; i++) {
          const v = parseInt(nums[i], 10);
          if (v >= 10000 && v <= 9999999) return v;
        }
        return null;
      };
      const expSoja    = findPrice('soja');
      const expGirasol = findPrice('girasol');
      if (expSoja)    out.expSoja    = expSoja;
      if (expGirasol) out.expGirasol = expGirasol;
      if (!expSoja && !expGirasol) errors.push('expeller: precios no encontrados en HTML');
    } else {
      errors.push('expeller corsproxy HTTP ' + r.status);
    }
  } catch (e) {
    errors.push('expeller corsproxy: ' + e.message);
    // Fallback: allorigins con timeout mas largo
    try {
      const url = encodeURIComponent('http://www.expeller.com.ar/pizarra.asp');
      const r2 = await fetch('https://api.allorigins.win/get?url=' + url, {
        signal: AbortSignal.timeout(20000)
      });
      if (r2.ok) {
        const wrapper = await r2.json();
        const html = wrapper.contents || '';
        const findPrice = function(keyword) {
          const lower = html.toLowerCase();
          const idx = lower.indexOf(keyword.toLowerCase());
          if (idx === -1) return null;
          const chunk = html.slice(Math.max(0, idx - 50), idx + 800);
          const nums = chunk.match(/\b\d{4,7}\b/g);
          if (!nums) return null;
          for (var i = 0; i < nums.length; i++) {
            const v = parseInt(nums[i], 10);
            if (v >= 10000 && v <= 9999999) return v;
          }
          return null;
        };
        const expSoja    = findPrice('soja');
        const expGirasol = findPrice('girasol');
        if (expSoja)    out.expSoja    = expSoja;
        if (expGirasol) out.expGirasol = expGirasol;
      }
    } catch (e2) { errors.push('expeller allorigins: ' + e2.message); }
  }

  // ── 4. Granos Rosario via BCR ──────────────────────────
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
    } else { errors.push('BCR HTTP ' + r.status); }
  } catch (e) { errors.push('BCR: ' + e.message); }

  // ── 5. Fallback granos desde CBOT ─────────────────────
  if (!out.gS && out.sojaI)  out.gS = Math.round(out.sojaI  * 0.88);
  if (!out.gM && out.maizI)  out.gM = Math.round(out.maizI  * 0.90);
  if (!out.gG && out.trigoI) out.gG = Math.round(out.trigoI * 0.92);

  if (Object.keys(out).length === 0) {
    return res.status(502).json({ error: 'Sin datos', errors: errors });
  }

  return res.status(200).json({
    precios: out,
    ts: new Date().toISOString(),
    errors: errors.length ? errors : undefined
  });
};
