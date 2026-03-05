// api/tc.js — Vercel serverless function
// Fetches tipos de cambio server-side (sin CORS)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const results = [];

  // Fuente 1: dolarapi — oficial, mayorista, blue, mep, ccl, cripto, tarjeta
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) results.push(...data);
    }
  } catch (e) {}

  // Fuente 2: BNA scraping — Divisa (mercado libre de cambios, mayorista cierre)
  // URL: bna.com.ar/Cotizador/MonedasHistorico — responde HTML plano, sin JS
  // Estructura confirmada: "Dolar U.S.A | 1391.50 | 1400.50"
  try {
    const r = await fetch('https://www.bna.com.ar/Cotizador/MonedasHistorico', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const html = await r.text();
      // Regex sobre "Dolar U.S.A" seguido de dos valores numéricos
      const m = html.match(/Dolar\s+U\.S\.A[\s|]+([\d.,]+)[\s|]+([\d.,]+)/i);
      if (m) {
        const buy  = parseFloat(m[1].replace(',', '.'));
        const sell = parseFloat(m[2].replace(',', '.'));
        if (sell > 500 && sell < 9999) {
          results.push({
            casa: 'divisa',
            nombre: 'Divisa BNA',
            compra: buy,
            venta: sell,
            fechaActualizacion: new Date().toISOString(),
          });
        }
      }
    }
  } catch (e) {}

  // Fallback: bluelytics si dolarapi falla
  if (results.length === 0) {
    try {
      const r = await fetch('https://api.bluelytics.com.ar/v2/latest', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(7000),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.oficial) results.push(
          { casa: 'oficial',  compra: d.oficial.value_buy,  venta: d.oficial.value_sell },
          { casa: 'blue',     compra: d.blue.value_buy,     venta: d.blue.value_sell    }
        );
      }
    } catch (e) {}
  }

  if (results.length === 0)
    return res.status(503).json({ error: 'Todas las fuentes fallaron' });

  return res.status(200).json(results);
}
