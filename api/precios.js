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

  // ── 2. Dolar Divisa BNA via argentinadatos ─────────────
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
      } else { errors.push('argentinadatos divisa: sin datos validos'); }
    } else { errors.push('argentinadatos divisa HTTP ' + r.status); }
  } catch (e) { errors.push('argentinadatos divisa: ' + e.message); }

  // ── 3. Expeller via expeller.com.ar ────────────────────
  try {
    const r = await fetch('http://www.expeller.com.ar/pizarra.asp', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: AbortSignal.timeout(12000)
    });
    if (r.ok) {
      const html = await r.text();
      const lower = html.toLowerCase();

      const findPrice = function(keyword) {
        // Busca bloque "expeller" que contenga el keyword
        let idx = lower.indexOf('expeller');
        while (idx !== -1) {
          const block = lower.slice(idx, idx + 200);
          if (block.includes(keyword.toLowerCase())) {
            const chunk = html.slice(idx, idx + 600);
            const re = /\b(\d{2,3}[.,]\d{3}|\d{5,7})\b/g;
            let m;
            while ((m = re.exec(chunk)) !== null) {
              const raw = m[1].replace(/\./g, '').replace(',', '');
              const v = parseInt(raw, 10);
              if (v >= 30000 && v <= 9999999) return v;
            }
          }
          idx = lower.indexOf('expeller', idx + 1);
        }
        return null;
      };

      const expSoja    = findPrice('soja');
      const expGirasol = findPrice('girasol');
      if (expSoja)    out.expSoja    = expSoja;
      if (expGirasol) out.expGirasol = expGirasol;
      if (!expSoja && !expGirasol) errors.push('expeller: precios no encontrados');
    } else { errors.push('expeller HTTP ' + r.status); }
  } catch (e) { errors.push('expeller: ' + e.message); }

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
