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

  // ── 2. Dólar Divisa BNA ────────────────────────────────
  // Intento A: dolarapi ambito (lista completa Ambito que incluye divisa)
  try {
    const r = await fetch('https://dolarapi.com/v1/ambito/dolares', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const data = await r.json();
      const divisa = data.find(function(d) {
        const c = (d.casa || d.nombre || '').toLowerCase();
        return c.includes('divis');
      });
      if (divisa && divisa.venta > 0) {
        out.divisa_sell = divisa.venta;
        out.divisa_buy  = divisa.compra || divisa.venta;
      } else {
        errors.push('ambito dolares: casas=' + data.map(function(d){ return d.casa; }).join(','));
      }
    } else {
      errors.push('ambito dolares HTTP ' + r.status);
    }
  } catch (e) { errors.push('ambito dolares: ' + e.message); }

  // Intento B: scraping directo BNA (server-side, sin CORS)
  if (!out.divisa_sell) {
    try {
      const r = await fetch('https://www.bna.com.ar/Personas', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-AR,es;q=0.9',
          'Cache-Control': 'no-cache',
        },
        signal: AbortSignal.timeout(10000)
      });
      if (r.ok) {
        const html = await r.text();
        // BNA tiene una tabla con filas: Dólar U.S.A. | compra | venta
        // La divisa aparece como segunda fila de la tabla de cotizaciones
        // Buscamos todos los pares de números que parecen TC (4 dígitos)
        const allMatches = html.match(/\b1[.,]\d{3}(?:[.,]\d{2})?\b/g) || [];
        // Buscar específicamente cerca de "divisa"
        const idx = html.toLowerCase().indexOf('divisa');
        if (idx > -1) {
          const chunk = html.slice(Math.max(0,idx-200), idx + 500);
          const nums = chunk.match(/\d{3,4}[.,]\d{2}/g);
          if (nums && nums.length >= 2) {
            const buy  = parseFloat(nums[0].replace(/\./g,'').replace(',','.'));
            const sell = parseFloat(nums[1].replace(/\./g,'').replace(',','.'));
            if (sell > 800 && sell < 9999) {
              out.divisa_sell = sell;
              out.divisa_buy  = buy;
            }
          }
        }
        if (!out.divisa_sell) {
          // Estrategia: tomar el oficial + 0.5% (divisa es casi igual al oficial en BNA)
          // Esto es un fallback aproximado
          errors.push('BNA: divisa no encontrada en HTML, usando aproximacion');
          if (out.sojaI) { // Solo si tenemos datos
            // No poner nada mejor que mostrar vacio
          }
        }
      } else {
        errors.push('BNA HTTP ' + r.status);
      }
    } catch (e) { errors.push('BNA: ' + e.message); }
  }

  // Intento C: bluelytics (tiene divisa como campo separado)
  if (!out.divisa_sell) {
    try {
      const r = await fetch('https://api.bluelytics.com.ar/v2/latest', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (r.ok) {
        const d = await r.json();
        // bluelytics tiene: oficial, blue, oficial_euro, blue_euro
        // No tiene divisa separada, pero el "oficial" de BNA es la base
        // La divisa BNA suele ser = oficial BNA venta
        if (d.oficial && d.oficial.value_sell > 0) {
          // Usar oficial como proxy de divisa si no hay mejor fuente
          out.divisa_sell = d.oficial.value_sell;
          out.divisa_buy  = d.oficial.value_buy;
          errors.push('divisa: usando oficial BNA como aproximacion');
        }
      }
    } catch (e) { errors.push('bluelytics: ' + e.message); }
  }

  // ── 3. Expeller — fetch directo, parsing mejorado ──────
  try {
    const r = await fetch('http://www.expeller.com.ar/pizarra.asp', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: AbortSignal.timeout(12000)
    });
    if (r.ok) {
      // El sitio devuelve Windows-1252 (latin1), no UTF-8
      const buf = await r.arrayBuffer();
      const html = new TextDecoder('windows-1252').decode(buf);

      // Extraer TODOS los números de 5-7 cifras del HTML
      const allNums = [];
      const re = /\b(\d{5,7})\b/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const v = parseInt(m[1], 10);
        if (v >= 10000 && v <= 9999999) allNums.push({ val: v, idx: m.index });
      }

      // Buscar el número más cercano después de "soja"
      const findNearest = function(keyword) {
        const lower = html.toLowerCase();
        let searchFrom = 0;
        while (true) {
          const idx = lower.indexOf(keyword, searchFrom);
          if (idx === -1) break;
          // Buscar el primer número válido en los siguientes 500 chars
          for (var i = 0; i < allNums.length; i++) {
            if (allNums[i].idx >= idx && allNums[i].idx <= idx + 500) {
              return allNums[i].val;
            }
          }
          searchFrom = idx + 1;
        }
        return null;
      };

      const expSoja    = findNearest('soja');
      const expGirasol = findNearest('girasol');

      if (expSoja)    out.expSoja    = expSoja;
      if (expGirasol) out.expGirasol = expGirasol;
      if (!expSoja && !expGirasol) {
        errors.push('expeller: html=' + html.length + 'chars, numeros=' + allNums.length + ', snippet=' + html.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').slice(0,300));
      }
    } else {
      errors.push('expeller HTTP ' + r.status);
    }
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
      const m2 = extract('Ma');
      const g = extract('Girasol');
      if (s) out.gS = s;
      if (m2) out.gM = m2;
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
