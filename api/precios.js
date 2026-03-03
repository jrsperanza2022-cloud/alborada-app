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

  // ── 2. Dolar Divisa BNA — endpoint directo ─────────────
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares/divisas', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const d = await r.json();
      if (d && d.venta > 0) {
        out.divisa_sell = d.venta;
        out.divisa_buy  = d.compra || d.venta;
      } else {
        errors.push('dolarapi divisas: respuesta vacia o sin venta');
      }
    } else {
      errors.push('dolarapi divisas HTTP ' + r.status);
    }
  } catch (e) { errors.push('dolarapi divisas: ' + e.message); }

  // Fallback divisa: argentinadatos.com
  if (!out.divisa_sell) {
    try {
      const r = await fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (r.ok) {
        const data = await r.json();
        const divisa = data.find(function(d) {
          const c = (d.casa || '').toLowerCase();
          return c.includes('divisa');
        });
        if (divisa && divisa.venta > 0) {
          out.divisa_sell = divisa.venta;
          out.divisa_buy  = divisa.compra || divisa.venta;
        } else {
          errors.push('argentinadatos: divisa no encontrada');
        }
      }
    } catch (e) { errors.push('argentinadatos fallback: ' + e.message); }
  }

  // ── 3. Expeller via Google Cache (HTTP bloqueado en Vercel) ──
  try {
    // Intentar via allorigins (proxy HTTPS que puede llegar a HTTP)
    const target = encodeURIComponent('http://www.expeller.com.ar/pizarra.asp');
    const r = await fetch('https://api.allorigins.win/get?url=' + target, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12000)
    });
    if (r.ok) {
      const wrapper = await r.json();
      const html = wrapper.contents || '';

      const findPrice = function(keyword) {
        const lower = html.toLowerCase();
        const idx = lower.indexOf(keyword.toLowerCase());
        if (idx === -1) return null;
        const chunk = html.slice(idx, idx + 800);
        const nums = chunk.match(/\b(\d{4,7})\b/g);
        if (!nums) return null;
        for (var i = 0; i < nums.length; i++) {
          const v = parseInt(nums[i], 10);
          if (v >= 30000 && v <= 9999999) return v;
        }
        return null;
      };

      const expSoja    = findPrice('Soja');
      const expGirasol = findPrice('Girasol');

      if (expSoja)    out.expSoja    = expSoja;
      if (expGirasol) out.expGirasol = expGirasol;
      if (!expSoja && !expGirasol) errors.push('expeller: precios no encontrados en HTML');
    } else {
      errors.push('expeller proxy HTTP ' + r.status);
    }
  } catch (e) { errors.push('expeller: ' + e.message); }

  // ── 4. Granos Rosario via BCR ──────────────────────────
  try {
    const r = await fetch('https://www.bcr.com.ar/es/mercados/cotizaciones/granos', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
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
    } else {
      errors.push('BCR HTTP ' + r.status);
    }
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
```

---

**Después del commit**, antes de mirar la app, abrí esto en el browser:
```
https://TU-APP.vercel.app/api/precios
