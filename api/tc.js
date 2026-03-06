// api/tc.js — Vercel serverless function
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const results = [];
  const errors  = [];

  // ── 1. dolarapi — oficial, mayorista, blue, mep, ccl ──────────
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) results.push(...data);
      else errors.push('dolarapi: respuesta vacia');
    } else errors.push('dolarapi HTTP ' + r.status);
  } catch (e) { errors.push('dolarapi: ' + e.message); }

  // ── 2. Divisa BNA — BCRA API oficial, endpoint confirmado ──────
  // GET /estadisticascambiarias/v1.0/Cotizaciones
  // Respuesta: { results: { fecha, detalle: [{ codigoMoneda, tipoCotizacion }] } }
  // tipoCotizacion = valor único (no compra/venta separados)
  try {
    const r = await fetch('https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const json = await r.json();
      const detalle = json.results && json.results.detalle ? json.results.detalle : [];
      const usd = detalle.find(d => d.codigoMoneda === 'USD');
      if (usd && usd.tipoCotizacion > 0) {
        results.push({
          casa: 'divisa',
          nombre: 'Divisa BNA',
          compra: usd.tipoCotizacion,
          venta:  usd.tipoCotizacion,
          fechaActualizacion: json.results.fecha || new Date().toISOString(),
        });
      } else {
        errors.push('BCRA cambiarias: USD no encontrado, detalle=' + JSON.stringify(detalle).slice(0,150));
      }
    } else errors.push('BCRA cambiarias HTTP ' + r.status);
  } catch (e) { errors.push('BCRA cambiarias: ' + e.message); }

  // ── 3. Fallback total: bluelytics ─────────────────────────────
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

  // Siempre devolver errors para diagnostico en caso de que divisa falte
  // Mantener compatibilidad: devolver array directo + errors en header
  res.setHeader("X-TC-Errors", JSON.stringify(errors));
  return res.status(200).json(results);
}
