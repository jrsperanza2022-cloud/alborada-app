// api/tc.js — Vercel serverless function
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const results = [];
  const errors  = [];

  // ── 1. dolarapi — oficial, mayorista, blue, mep, ccl ──
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) results.push(...data);
      else errors.push('dolarapi: respuesta vacia');
    } else { errors.push('dolarapi HTTP ' + r.status); }
  } catch (e) { errors.push('dolarapi: ' + e.message); }

  // ── 2. Divisa BNA — BCRA API oficial (accesible desde cualquier IP) ──
  // Variable 4 = Tipo de cambio de referencia (COM A 3500) compra/venta BNA
  // https://api.bcra.gob.ar/estadisticas/v3.0/cotizaciones
  try {
    const r = await fetch('https://api.bcra.gob.ar/estadisticas/v3.0/cotizaciones', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const data = await r.json();
      // Buscar detalle USD en el array de cotizaciones
      const usd = (data.results || data).find
        ? (data.results || data).find(d =>
            (d.codigoMoneda || d.codigo || '').toUpperCase() === 'USD'
          )
        : null;
      if (usd && usd.tipoCambioVenta > 0) {
        results.push({
          casa: 'divisa',
          nombre: 'Divisa BNA',
          compra: usd.tipoCambioCompra || usd.tipoCambioVenta,
          venta:  usd.tipoCambioVenta,
          fechaActualizacion: new Date().toISOString(),
        });
      } else {
        errors.push('BCRA API: USD no encontrado, keys=' + JSON.stringify(Object.keys(data)).slice(0,100));
      }
    } else { errors.push('BCRA API HTTP ' + r.status); }
  } catch (e) { errors.push('BCRA API: ' + e.message); }

  // ── 3. Divisa BNA fallback — scraping Cotizador ────────
  // Nota: puede fallar si BNA bloquea IPs de Vercel (EEUU)
  if (!results.find(d => d.casa === 'divisa')) {
    try {
      const r = await fetch('https://www.bna.com.ar/Cotizador/MonedasHistorico', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const html = await r.text();
        const m = html.match(/Dolar\s+U\.S\.A[\s|]+([\d.,]+)[\s|]+([\d.,]+)/i);
        if (m) {
          const buy  = parseFloat(m[1].replace(',', '.'));
          const sell = parseFloat(m[2].replace(',', '.'));
          if (sell > 500 && sell < 9999) {
            results.push({ casa: 'divisa', nombre: 'Divisa BNA', compra: buy, venta: sell,
                           fechaActualizacion: new Date().toISOString() });
          } else { errors.push('BNA: valores fuera de rango: ' + m[1] + ' / ' + m[2]); }
        } else {
          errors.push('BNA: regex no matcheo, snippet=' + html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,200));
        }
      } else { errors.push('BNA HTTP ' + r.status); }
    } catch (e) { errors.push('BNA scraping: ' + e.message); }
  }

  // ── 4. Fallback total: bluelytics ─────────────────────
  if (results.length === 0) {
    try {
      const r = await fetch('https://api.bluelytics.com.ar/v2/latest', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(7000),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.oficial) results.push(
          { casa: 'oficial', compra: d.oficial.value_buy,  venta: d.oficial.value_sell },
          { casa: 'blue',    compra: d.blue.value_buy,     venta: d.blue.value_sell    }
        );
      }
    } catch (e) { errors.push('bluelytics: ' + e.message); }
  }

  if (results.length === 0)
    return res.status(503).json({ error: 'Todas las fuentes fallaron', errors });

  return res.status(200).json(results, errors.length ? { errors } : undefined);
}
