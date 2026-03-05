// api/tc.js — Vercel serverless function
// Fetches tipos de cambio from dolarapi.com server-side (no CORS issues)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const sources = [
    'https://dolarapi.com/v1/dolares',
    'https://api.bluelytics.com.ar/v2/latest',
  ];

  for (const url of sources) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'AlboradaApp/1.0' },
        signal: AbortSignal.timeout(7000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      // Normalize bluelytics to dolarapi array format
      if (!Array.isArray(data) && data.oficial) {
        const normalized = [
          { casa: 'oficial',   compra: data.oficial.value_buy,  venta: data.oficial.value_sell,  fechaActualizacion: new Date().toISOString() },
          { casa: 'blue',      compra: data.blue.value_buy,     venta: data.blue.value_sell,     fechaActualizacion: new Date().toISOString() },
        ];
        return res.status(200).json(normalized);
      }
      if (Array.isArray(data) && data.length > 0) {
        return res.status(200).json(data);
      }
    } catch (e) { /* try next */ }
  }

  res.status(503).json({ error: 'Todas las fuentes fallaron' });
}
