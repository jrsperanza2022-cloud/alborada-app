// Vercel Serverless Function: /api/precios
// Fuentes: stooq.com (CBOT) + argentinadatos.com (divisa) + BCR (granos) + expeller.com.ar
// Sin API key — corre server-side sin restricciones CORS

export default async function handler(req, res) {
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
      const r = await fetch(`https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) { errors.push(`stooq/${sym} HTTP ${r.status}`); continue; }
      const lines = (await r.text()).trim().split('\n');
      if (lines.length < 2) { errors.push(`stooq/${sym} vacío`); continue; }
      const close = parseFloat(lines[1].split(',')[6]);
      if (!close || close <= 0) { errors.push(`stooq/${sym} sin precio`); continue; }
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
    } catch (e) { errors.push(`stooq/${sym}: ${e.message}`); }
  }

  // ── 2. Dólar Divisa BNA via argentinadatos.com ─────────
  try {
    const r = await fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const data = await r.json();
      const divisa = data.find(d => d.casa && d.casa.toLowerCase().includes('divisa'));
      if (divisa && divisa.venta > 0) {
        out.divisa_sell = divisa.venta;
        out.divisa_buy  = divisa.compra || divisa.venta;
      } else { errors.push('argentinadatos: divisa no encontrada'); }
    } else { errors.push(`argentinadatos HTTP ${r.status}`); }
  } catch (e) { errors.push(`argentinadatos: ${e.message}`); }

  // Fallback divisa: BNA scraping
  if (!out.divisa_sell) {
    try {
      const r = await fetch('https://www.bna.com.ar/Personas', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
        signal: AbortSignal.timeout(10000)
      });
      if (r.ok) {
        const html = await r.text();
        const m = html.match(/divisa[\s\S]{0,3000}?(\d{3,4}[,\.]\d{2})[\s\S]{0,200}?(\d{3,4}[,\.]\d{2})/i);
        if (m) {
          const buy = parseFloat(m[1].replace(',', '.'));
          const sell = parseFloat(m[2].replace(',', '.'));
          if (sell > 500 && sell < 5000) { out.divisa_sell = sell; out.divisa_buy = buy; }
        }
      }
    } catch (e) { errors.push(`BNA fallback: ${e.message}`); }
  }

  // ── 3. AFA SCL — afascl.coop/afadiario/mercados-en-linea ─
  // Fuente: Asociación de Federadas Argentinas (AFA)
  // Provee: pizarra granos $/Ton, CBOT aceite USD/Ton (delay 20min),
  //         futuros MatbaRofex Soja/Maíz/Trigo Rosario en USD
  try {
    const r = await fetch('https://www.afascl.coop/afadiario/mercados-en-linea', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-AR,es;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(10000)
    });
    if (r.ok) {
      const html = await r.text();

      // ── Pizarra granos en $/Ton ──────────────────────────
      // Estructura: "Soja
San Martín
#### $ 462000"
      const parsePizarra = (label) => {
        const re = new RegExp(label + '[\s\S]{0,120}?\$\s*([\d\.]+)', 'i');
        const m = html.match(re);
        if (!m) return null;
        const v = parseFloat(m[1].replace(/\./g, ''));
        return (v > 10000 && v < 9999999) ? v : null;
      };
      const afaSoja    = parsePizarra('Soja');
      const afaMaiz    = parsePizarra('Maíz');
      const afaGirasol = parsePizarra('Girasol');
      const afaTrigo   = parsePizarra('Trigo');
      const afaSorgo   = parsePizarra('Sorgo');
      if (afaSoja)    out.pizSoja    = afaSoja;
      if (afaMaiz)    out.pizMaiz    = afaMaiz;
      if (afaGirasol) out.pizGirasol = afaGirasol;
      if (afaTrigo)   out.pizTrigo   = afaTrigo;
      if (afaSorgo)   out.pizSorgo   = afaSorgo;

      // ── CBOT Aceite en USD/Ton (delay 20min) ─────────────
      // Tabla CMA-CBOT: fila "Aceite | Mar 26 | diff | precio"
      // precio ya viene en USD/Ton métrica
      const aceiteRe = /Aceite[\s\S]{0,60}?([\d]+\.[\d]+)/i;
      const aceiteM  = html.match(aceiteRe);
      if (aceiteM) {
        const aceiteUSD = parseFloat(aceiteM[1]);
        if (aceiteUSD > 500 && aceiteUSD < 5000) {
          // Aceite soja crudo CBOT en USD/Ton — usarlo directo
          out.aSC = Math.round(aceiteUSD * 1.00);  // crudo
          out.aSR = Math.round(aceiteUSD * 1.04);  // refinado soja
          out.aMC = Math.round(aceiteUSD * 0.88);  // crudo maíz
          out.aMR = Math.round(aceiteUSD * 0.92);  // refinado maíz
          out.aGC = Math.round(aceiteUSD * 1.15);  // crudo girasol
          out.aGR = Math.round(aceiteUSD * 1.20);  // refinado girasol
        }
      }

      // ── MatbaRofex: soja disponible más cercano en USD/Ton ─
      // Fila más líquida: SOJ.ROS/MAY26 o similar con ajuste > 0
      const rofexSojaRe = /SOJ\.ROS\/\w+[\s|]+[\d.]+[\s|]+[\d.]*[\s|]+[\d.]*[\s|]+([\d.]+)/g;
      let rofexBestSoja = null;
      let rm;
      while ((rm = rofexSojaRe.exec(html)) !== null) {
        const ajuste = parseFloat(rm[1]);
        if (ajuste > 200 && ajuste < 1000) { rofexBestSoja = ajuste; break; }
      }
      if (rofexBestSoja) out.rofexSoja = rofexBestSoja;

      if (!afaSoja && !aceiteM) errors.push('AFA: sin datos parseables');
    } else { errors.push(`AFA HTTP ${r.status}`); }
  } catch (e) { errors.push(`AFA: ${e.message}`); }

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
      const extract = (pattern) => {
        const re = new RegExp(pattern + '[\\s\\S]{0,400}?>(\\d{2,4}(?:[,.]\\d{1,2})?)<', 'i');
        const m = html.match(re);
        if (!m) return null;
        const v = parseFloat(m[1].replace(',', '.'));
        return (v > 50 && v < 2000) ? v : null;
      };
      const s = extract('Soja');
      const m = extract('Ma[íi]z');
      const g = extract('Girasol');
      if (s) out.gS = s;
      if (m) out.gM = m;
      if (g) out.gG = g;
    } else { errors.push(`BCR HTTP ${r.status}`); }
  } catch (e) { errors.push(`BCR: ${e.message}`); }

  // ── 5. Fallback granos Rosario desde CBOT ─────────────
  if (!out.gS && out.sojaI)  out.gS = Math.round(out.sojaI  * 0.88);
  if (!out.gM && out.maizI)  out.gM = Math.round(out.maizI  * 0.90);
  if (!out.gG && out.trigoI) out.gG = Math.round(out.trigoI * 0.92);

  if (Object.keys(out).length === 0) {
    return res.status(502).json({ error: 'Sin datos', errors });
  }

  return res.status(200).json({
    precios: out,
    ts: new Date().toISOString(),
    errors: errors.length ? errors : undefined
  });
}
