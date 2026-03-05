// api/tc.js — Vercel serverless function
// Fetches tipos de cambio + divisa BNA server-side (no CORS issues)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const results = [];

  // Fuente 1: dolarapi /v1/dolares — oficial, mayorista, blue, mep, ccl
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares', {
      headers: { 'User-Agent': 'AlboradaApp/1.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) {
        results.push(...data);
      }
    }
  } catch (e) {}

  // Fuente 2: dolarapi /v1/ambito/dolares — incluye divisa BNA
  try {
    const r = await fetch('https://dolarapi.com/v1/ambito/dolares', {
      headers: { 'User-Agent': 'AlboradaApp/1.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data)) {
        // Solo agregar divisa (evitar duplicar oficial/blue/etc)
        const divisas = data.filter(d =>
          (d.casa || d.nombre || '').toLowerCase().includes('divis')
        );
        results.push(...divisas);
      }
    }
  } catch (e) {}

  // Fallback: bluelytics si dolarapi falla
  if (results.length === 0) {
    try {
      const r = await fetch('https://api.bluelytics.com.ar/v2/latest', {
        headers: { 'User-Agent': 'AlboradaApp/1.0' },
        signal: AbortSignal.timeout(7000),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.oficial) results.push(
          { casa: 'oficial',   compra: d.oficial.value_buy,  venta: d.oficial.value_sell },
          { casa: 'blue',      compra: d.blue.value_buy,     venta: d.blue.value_sell    }
        );
      }
    } catch (e) {}
  }

  if (results.length === 0) {
    return res.status(503).json({ error: 'Todas las fuentes fallaron' });
  }

  return res.status(200).json(results);
}
