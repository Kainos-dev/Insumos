'use strict';

const PDFDocument = require('pdfkit');
const { get, all } = require('../db/database');

const TALLES = ['35','36','37','38','39','40','41','42','43','44','45','46'];

/**
 * Genera PDF landscape con exactamente 2 hojas lógicas.
 * Hoja 1: Fondos
 * Hoja 2: Plantillas + Accesorios (cierre + hebilla)
 *
 * Cada fila corresponde a UN detalle (numero_pedido único).
 * El nombre del producto incluye "(p.N)" para identificar el bloque.
 * Columna TOTAL muestra pares totales de ese bloque.
 */
/** Fecha y hora en Argentina (dd/mm/aaaa hh:mm), sin depender de la zona del servidor. */
function fechaAR(fecha) {
  if (!fecha) return '';
  return new Date(fecha).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function generarPDFOrden(orden_id, res) {
  const orden = Number.isInteger(orden_id) ? await get('SELECT * FROM ordenes_produccion WHERE id=?', [orden_id]) : null;
  if (!orden) {
    res.status(404).json({ error: 'Planilla no encontrada' });
    return;
  }

  // Leer detalles ordenados por numero_pedido.
  // Cada fila es una línea independiente — NO se fusionan productos iguales.
  const detalles = await all(`
    SELECT d.id, d.producto_id, d.talle, d.cantidad, d.numero_pedido,
           p.nombre AS producto_nombre, p.plantilla_id, p.fondo_id,
           i1.nombre AS plantilla_nombre,
           i2.nombre AS fondo_nombre,
           i2.color  AS fondo_color
    FROM detalle_orden d
    JOIN productos p  ON p.id  = d.producto_id
    JOIN insumos i1   ON i1.id = p.plantilla_id
    JOIN insumos i2   ON i2.id = p.fondo_id
    WHERE d.orden_id = ?
    ORDER BY d.numero_pedido ASC, d.id ASC
  `, [orden_id]);

  // Construir las "filas de impresión":
  // Una fila por detalle. El nombre del producto lleva "(p.N)".
  // Los talles de un mismo numero_pedido se muestran en su propia fila.
  // Como cada detalle tiene un único talle, armamos el mapa de talles por fila.
  //
  // Para el PDF agrupamos por numero_pedido para mostrar una fila por bloque
  // (un bloque = un llamado a agregarDetallesBulk, que puede tener varios talles
  //  pero cada uno insertado como fila independiente con su propio numero_pedido).
  // Por lo tanto: una fila en el PDF = una fila en detalle_orden = un numero_pedido.

  // Accesorios de todos los productos de la planilla, en una sola consulta.
  const accesoriosDe = new Map();
  const productoIds = [...new Set(detalles.map(d => d.producto_id))];
  for (const a of await all(`
        SELECT pa.producto_id, pa.cantidad_por_par, i.nombre AS insumo_nombre, i.tipo, i.color
        FROM producto_accesorios pa
        JOIN insumos i ON i.id = pa.insumo_id
        WHERE pa.producto_id = ANY(?::int[])
        ORDER BY pa.id
      `, [productoIds])) {
    if (!accesoriosDe.has(a.producto_id)) accesoriosDe.set(a.producto_id, []);
    accesoriosDe.get(a.producto_id).push(a);
  }

  const agrupados = {};

  for (const d of detalles) {
    if (!agrupados[d.numero_pedido]) {
      const accesorios = accesoriosDe.get(d.producto_id) || [];

      agrupados[d.numero_pedido] = {
        numero_pedido: d.numero_pedido,
        producto_id: d.producto_id,
        nombre_display: d.producto_nombre + ' (p.' + d.numero_pedido + ')',
        plantilla_nombre: d.plantilla_nombre,
        fondo_nombre: d.fondo_nombre,
        fondo_color: d.fondo_color,
        talles: {},
        accesorios,
      };
    }

    agrupados[d.numero_pedido].talles[d.talle] =
      (agrupados[d.numero_pedido].talles[d.talle] || 0) + d.cantidad;
  }

  const filasPDF = Object.values(agrupados);

  const totalPares = filasPDF.reduce(
    (s, f) => s + Object.values(f.talles).reduce((a, b) => a + b, 0), 0
  );
  const genDate = fechaAR(new Date());

  // ——— PDF setup ———
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 0,
    info: { Title: `Planilla de Corte #${orden_id}` },
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="planilla-${orden_id}.pdf"`);
  doc.pipe(res);

  const PW = doc.page.width;   // 841.89
  const PH = doc.page.height;  // 595.28
  const ML = 24;
  const CW = PW - ML * 2;

  const FONT  = 'Helvetica';
  const FONTB = 'Helvetica-Bold';

  const C_DARKBG = '#111827';
  const C_SUBBG  = '#1e3a5f';
  const C_ALT    = '#f7f7f7';
  const C_ACCENT = '#dc2626';
  const C_GOLD   = '#b45309';
  const C_GRID   = '#e5e7eb';
  const C_TEXT   = '#111827';
  const C_MUTED  = '#6b7280';
  const C_LIGHT  = '#d1d5db';

  const HEADER_H = 46;
  const CH_H     = 20;
  const ROW_H    = 20;
  const FOOTER_H = 16;
  const TOP_BODY = HEADER_H + 6;

  const COL_NP_W   = 30;   // columna p.N
  const COL_CANT_W = 36;   // columna TOTAL pares
  const COL_PROD_W = 122;  // nombre producto
  const COL_INSU_W = 110;  // insumo (fondo/plantilla)

  const ACC_LABEL_W = 88;
  const ACC_CANT_W  = 32;
  const ACC_COLS    = (ACC_LABEL_W + ACC_CANT_W) * 2;

  const TALLE_FONDOS = Math.floor(
    (CW - COL_NP_W - COL_CANT_W - COL_PROD_W - COL_INSU_W) / TALLES.length
  );
  const TALLE_PLANT  = Math.floor(
    (CW - COL_NP_W - COL_CANT_W - COL_PROD_W - COL_INSU_W - ACC_COLS) / TALLES.length
  );

  // ——— Helpers ———

  function drawHeader(title, hoja) {
    doc.rect(0, 0, PW, HEADER_H).fill(C_DARKBG);
    doc.font(FONTB).fontSize(14).fillColor('white')
      .text(`PLANILLA DE CORTE #${orden_id} — ${title}`, ML, 10, { width: PW * 0.62 });
    const sub = [
      orden.descripcion || 'Sin descripción',
      fechaAR(orden.created_at),
      `Estado: ${orden.estado.toUpperCase()}`,
      `Líneas: ${filasPDF.length}`,
      `Pares totales: ${totalPares}`,
      `Generado: ${genDate}`,
    ].join('  ·  ');
    doc.font(FONT).fontSize(7.5).fillColor('#9ca3af')
      .text(sub, ML, 30, { width: PW * 0.72 });
    doc.font(FONTB).fontSize(12).fillColor(C_ACCENT)
      .text(`Hoja ${hoja} / 2`, PW - ML - 80, 15, { width: 80, align: 'right' });
  }

  function drawFooter(y) {
    if (y + 12 < PH - 4) {
      doc.rect(ML, y + 4, CW, 0.5).fill(C_GRID);
      doc.font(FONT).fontSize(7).fillColor(C_MUTED)
        .text(
          `Líneas: ${filasPDF.length}  ·  Total pares: ${totalPares}  ·  Generado: ${genDate}  ·  Planilla de Corte #${orden_id}`,
          ML, y + 7, { width: CW }
        );
    }
  }

  function colHeaderFondos(y) {
    doc.rect(ML, y, CW, CH_H).fill(C_SUBBG);
    doc.fillColor('white').font(FONTB).fontSize(7);
    let x = ML;
    doc.text('P.', x, y + 6, { width: COL_NP_W, align: 'center' });   x += COL_NP_W;
    doc.text('TOTAL', x, y + 6, { width: COL_CANT_W, align: 'center' }); x += COL_CANT_W;
    doc.text('PRODUCTO', x + 3, y + 6, { width: COL_PROD_W });          x += COL_PROD_W;
    doc.text('FONDO', x + 3, y + 6, { width: COL_INSU_W });             x += COL_INSU_W;
    for (const t of TALLES) {
      doc.text(t, x, y + 6, { width: TALLE_FONDOS, align: 'center' });
      x += TALLE_FONDOS;
    }
    return y + CH_H;
  }

  function drawRowFondo(y, idx, fila) {
    const total = Object.values(fila.talles).reduce((s, v) => s + v, 0);
    doc.rect(ML, y, CW, ROW_H).fill(idx % 2 === 0 ? 'white' : C_ALT);
    doc.rect(ML, y, CW, ROW_H).stroke(C_GRID).lineWidth(0.3);

    let x = ML;

    // Número de pedido
    doc.font(FONTB).fontSize(8).fillColor(C_MUTED)
      .text('p.' + fila.numero_pedido, x, y + 6, { width: COL_NP_W, align: 'center' });
    x += COL_NP_W;

    // Total pares del bloque
    doc.font(FONTB).fontSize(9).fillColor(C_ACCENT)
      .text(String(total), x, y + 6, { width: COL_CANT_W, align: 'center' });
    x += COL_CANT_W;

    // Nombre producto (sin el "(p.N)" ya implícito en la col anterior)
    doc.font(FONTB).fontSize(8).fillColor(C_TEXT)
      .text(fila.nombre_display, x + 3, y + 6, { width: COL_PROD_W - 4, ellipsis: true });
    x += COL_PROD_W;

    const fondoLabel = fila.fondo_color
      ? `${fila.fondo_nombre} (${fila.fondo_color})`
      : fila.fondo_nombre;
    doc.font(FONT).fontSize(7.5).fillColor('#374151')
      .text(fondoLabel, x + 3, y + 6, { width: COL_INSU_W - 4, ellipsis: true });
    x += COL_INSU_W;

    for (const t of TALLES) {
      const qty = fila.talles[t] || 0;
      if (qty > 0) {
        doc.font(FONTB).fontSize(8.5).fillColor(C_TEXT)
          .text(String(qty), x, y + 6, { width: TALLE_FONDOS, align: 'center' });
      } else {
        doc.font(FONT).fontSize(7).fillColor(C_LIGHT)
          .text('·', x, y + 7, { width: TALLE_FONDOS, align: 'center' });
      }
      x += TALLE_FONDOS;
    }
    return y + ROW_H;
  }

  function colHeaderPlantillas(y) {
    doc.rect(ML, y, CW, CH_H).fill(C_SUBBG);
    doc.fillColor('white').font(FONTB).fontSize(7);
    let x = ML;
    doc.text('P.', x, y + 6, { width: COL_NP_W, align: 'center' });     x += COL_NP_W;
    doc.text('TOTAL', x, y + 6, { width: COL_CANT_W, align: 'center' }); x += COL_CANT_W;
    doc.text('PRODUCTO', x + 3, y + 6, { width: COL_PROD_W });            x += COL_PROD_W;
    doc.text('PLANTILLA', x + 3, y + 6, { width: COL_INSU_W });           x += COL_INSU_W;
    for (const t of TALLES) {
      doc.text(t, x, y + 6, { width: TALLE_PLANT, align: 'center' });
      x += TALLE_PLANT;
    }
    doc.text('CIERRE', x + 3, y + 6, { width: ACC_LABEL_W });   x += ACC_LABEL_W;
    doc.text('CANT',   x,     y + 6, { width: ACC_CANT_W, align: 'center' }); x += ACC_CANT_W;
    doc.text('HEBILLA', x + 3, y + 6, { width: ACC_LABEL_W });  x += ACC_LABEL_W;
    doc.text('CANT',   x,     y + 6, { width: ACC_CANT_W, align: 'center' });
    return y + CH_H;
  }

  function drawRowPlantilla(y, idx, fila) {
    const total   = Object.values(fila.talles).reduce((s, v) => s + v, 0);
    const cierre  = (fila.accesorios || []).find(a => a.tipo === 'cierre');
    const hebilla = (fila.accesorios || []).find(a => a.tipo === 'hebilla');

    doc.rect(ML, y, CW, ROW_H).fill(idx % 2 === 0 ? 'white' : C_ALT);
    doc.rect(ML, y, CW, ROW_H).stroke(C_GRID).lineWidth(0.3);

    let x = ML;

    // Número de pedido
    doc.font(FONTB).fontSize(8).fillColor(C_MUTED)
      .text('p.' + fila.numero_pedido, x, y + 6, { width: COL_NP_W, align: 'center' });
    x += COL_NP_W;

    doc.font(FONTB).fontSize(9).fillColor(C_ACCENT)
      .text(String(total), x, y + 6, { width: COL_CANT_W, align: 'center' });
    x += COL_CANT_W;

    doc.font(FONTB).fontSize(8).fillColor(C_TEXT)
      .text(fila.nombre_display, x + 3, y + 6, { width: COL_PROD_W - 4, ellipsis: true });
    x += COL_PROD_W;

    doc.font(FONT).fontSize(7.5).fillColor('#374151')
      .text(fila.plantilla_nombre, x + 3, y + 6, { width: COL_INSU_W - 4, ellipsis: true });
    x += COL_INSU_W;

    for (const t of TALLES) {
      const qty = fila.talles[t] || 0;
      if (qty > 0) {
        doc.font(FONTB).fontSize(8.5).fillColor(C_TEXT)
          .text(String(qty), x, y + 6, { width: TALLE_PLANT, align: 'center' });
      } else {
        doc.font(FONT).fontSize(7).fillColor(C_LIGHT)
          .text('·', x, y + 7, { width: TALLE_PLANT, align: 'center' });
      }
      x += TALLE_PLANT;
    }

    const cierreNombre = cierre
      ? (cierre.color ? `${cierre.insumo_nombre} (${cierre.color})` : cierre.insumo_nombre)
      : '—';
    const cierreQty = cierre ? String(cierre.cantidad_por_par * total) : '—';

    doc.font(FONT).fontSize(7).fillColor(cierre ? C_TEXT : C_LIGHT)
      .text(cierreNombre, x + 3, y + 6, { width: ACC_LABEL_W - 4, ellipsis: true });
    x += ACC_LABEL_W;
    doc.font(cierre ? FONTB : FONT).fontSize(8).fillColor(cierre ? C_GOLD : C_LIGHT)
      .text(cierreQty, x, y + 6, { width: ACC_CANT_W, align: 'center' });
    x += ACC_CANT_W;

    const hebillaNombre = hebilla
      ? (hebilla.color ? `${hebilla.insumo_nombre} (${hebilla.color})` : hebilla.insumo_nombre)
      : '—';
    const hebillaQty = hebilla ? String(hebilla.cantidad_por_par * total) : '—';

    doc.font(FONT).fontSize(7).fillColor(hebilla ? C_TEXT : C_LIGHT)
      .text(hebillaNombre, x + 3, y + 6, { width: ACC_LABEL_W - 4, ellipsis: true });
    x += ACC_LABEL_W;
    doc.font(hebilla ? FONTB : FONT).fontSize(8).fillColor(hebilla ? C_GOLD : C_LIGHT)
      .text(hebillaQty, x, y + 6, { width: ACC_CANT_W, align: 'center' });

    return y + ROW_H;
  }

  function newPageHeader(title, hoja) {
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
    drawHeader(title, hoja);
  }

  // ═══════════════════════════════
  // HOJA 1: FONDOS
  // ═══════════════════════════════
  drawHeader('FONDOS', 1);
  let y = TOP_BODY;
  y = colHeaderFondos(y);

  let rowIdx = 0;
  for (const fila of filasPDF) {
    if (y + ROW_H + FOOTER_H > PH - 4) {
      newPageHeader('FONDOS (cont.)', 1);
      y = TOP_BODY;
      y = colHeaderFondos(y);
      rowIdx = 0;
    }
    y = drawRowFondo(y, rowIdx++, fila);
  }
  drawFooter(y);

  // ═══════════════════════════════
  // HOJA 2: PLANTILLAS + ACCESORIOS
  // ═══════════════════════════════
  doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
  drawHeader('PLANTILLAS + ACCESORIOS', 2);
  y = TOP_BODY;
  y = colHeaderPlantillas(y);

  rowIdx = 0;
  for (const fila of filasPDF) {
    if (y + ROW_H + FOOTER_H > PH - 4) {
      newPageHeader('PLANTILLAS + ACCESORIOS (cont.)', 2);
      y = TOP_BODY;
      y = colHeaderPlantillas(y);
      rowIdx = 0;
    }
    y = drawRowPlantilla(y, rowIdx++, fila);
  }
  drawFooter(y);

  doc.end();
}

module.exports = { generarPDFOrden };
