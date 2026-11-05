// ============================================================
// pages/ordenes.js
//
// Cambios en esta versión:
// 1. Layout invertido: formulario ARRIBA, tabla de detalles ABAJO
// 2. Tabla de detalles muestra columna "p.N" (numero_pedido)
// 3. No se fusionan líneas — cada bulk-insert genera filas independientes
// 4. Vistas previas (fondos y plantillas) muestran "Producto (p.N)"
//    una fila por detalle, sin agrupar por producto_id
// 5. Verificación procesa línea por línea en ORDER BY numero_pedido
// ============================================================

let _ordenActual   = null;
let _productosCache = [];

// ——— LISTADO ———

async function renderOrdenes(subId) {
  setPageTitle('Planillas de Corte');
  setTopbarActions('<button class="btn btn-primary" onclick="modalCrearOrden()">+ Nueva planilla</button>');
  loading();

  if (subId) {
    await renderOrdenDetalle(Number(subId));
    return;
  }

  const ordenes = await API.ordenes.list();

  if (!ordenes.length) {
    document.getElementById('pageBody').innerHTML =
      '<div class="card">' + emptyState('Sin planillas de corte') + '</div>';
    return;
  }

  let rows = '';
  for (const o of ordenes) {
    const cancelBtn = o.estado === 'borrador'
      ? '<button class="btn btn-sm btn-danger" onclick="cancelarOrdenLista(' + o.id + ')">Cancelar</button>'
      : '';
    rows +=
      '<tr>' +
        '<td class="text-muted">#' + o.id + '</td>' +
        '<td><strong>' + escHtml(o.descripcion || '—') + '</strong></td>' +
        '<td>' + estadoBadge(o.estado) + '</td>' +
        '<td>' + (o.lineas || 0) + '</td>' +
        '<td>' + (o.total_pares || 0) + '</td>' +
        '<td class="text-muted">' + formatDate(o.created_at) + '</td>' +
        '<td><div class="flex-gap">' +
          '<button class="btn btn-sm" onclick="renderOrdenDetalle(' + o.id + ')">Ver</button>' +
          cancelBtn +
        '</div></td>' +
      '</tr>';
  }

  document.getElementById('pageBody').innerHTML =
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>N.º planilla</th><th>Descripción</th><th>Estado</th>' +
    '<th>Líneas</th><th>Total pares</th><th>Fecha</th><th>Acciones</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div></div>';
}

async function cancelarOrdenLista(id) {
  if (!confirmAction('¿Cancelar esta planilla?')) return;
  try {
    await API.ordenes.cancelar(id);
    toast('Planilla cancelada', 'success');
    renderOrdenes();
  } catch (e) { toast(e.message, 'error'); }
}

// ——— DETALLE ———

async function renderOrdenDetalle(id) {
  loading();
  const [orden, productos, insumos] = await Promise.all([
    API.ordenes.get(id),
    API.productos.list(),
    API.insumos.list(),
  ]);
  _ordenActual    = orden;
  _productosCache = productos;

  // Poblar _insumosCache global para color de fondos en vistas previas
  if (typeof _insumosCache !== 'undefined') {
    _insumosCache.length = 0;
    insumos.forEach(i => _insumosCache.push(i));
  }

  const isBorrador = orden.estado === 'borrador';

  // Columna derecha: acciones + exportar + vistas previas
  const colDerecha =
    (isBorrador
      ? '<div class="card">' +
          '<div class="card-title">Acciones</div>' +
          '<div style="display:flex;flex-direction:column;gap:8px">' +
            '<button class="btn btn-gold"   onclick="verificarOrden()">🔍 Verificar insumos</button>' +
            '<button class="btn btn-green"  onclick="confirmarOrdenActual()">✓ Confirmar planilla</button>' +
            '<button class="btn btn-danger" onclick="cancelarOrdenActual()">✕ Cancelar planilla</button>' +
          '</div>' +
        '</div>'
      : '') +
    '<div class="card">' +
      '<div class="card-title">Imprimir / Exportar</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' +
        '<button class="btn btn-primary" onclick="imprimirOrden(' + orden.id + ')">🖨 Imprimir planilla</button>' +
        '<a class="btn" href="' + API.ordenes.pdfUrl(orden.id) + '" target="_blank" download="planilla-' + orden.id + '.pdf">⬇ Descargar PDF</a>' +
      '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-title">Vista Previa — Fondos</div>' +
      '<div class="table-wrap" style="font-size:11px">' + renderSheetFondos(orden.detalles) + '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-title">Vista Previa — Plantillas + Accesorios</div>' +
      '<div class="table-wrap" style="font-size:11px">' + renderSheetPlantillas(orden.detalles) + '</div>' +
    '</div>';

  // Columna izquierda: FORMULARIO ARRIBA — TABLA ABAJO
  const colIzquierda =
    // 1. Formulario de agregar (siempre arriba, visible de entrada)
    (isBorrador
      ? '<div class="card">' +
          '<div class="card-title">Agregar producto a la planilla</div>' +
          buildAddBloqueForm(productos) +
        '</div>'
      : '') +
    // 2. Tabla de detalles (debajo del formulario)
    '<div class="card">' +
      '<div class="card-title">Detalle de la planilla' +
        (orden.detalles.length ? ' <span class="text-muted" style="font-size:11px;font-weight:400">(' + orden.detalles.length + ' líneas)</span>' : '') +
      '</div>' +
      '<div class="table-wrap">' +
        '<table>' +
          '<thead><tr>' +
            '<th style="width:38px">p.</th>' +
            '<th>Producto</th><th>Talle</th><th>Cantidad</th>' +
            (isBorrador ? '<th style="width:40px"></th>' : '') +
          '</tr></thead>' +
          '<tbody id="detallesBody">' + renderDetallesRows(orden.detalles, isBorrador) + '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';

  document.getElementById('pageBody').innerHTML =
    // Cabecera de la planilla
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">' +
      '<button class="btn btn-sm btn-ghost" onclick="renderOrdenes()">← Volver</button>' +
      '<h2 class="detail-title">' +
        'Planilla de Corte #' + orden.id + ' ' + estadoBadge(orden.estado) +
      '</h2>' +
      '<span class="text-muted">' + escHtml(orden.descripcion || '') + '</span>' +
    '</div>' +

    // Dos columnas
    '<div class="two-col" style="margin-bottom:16px">' +
      '<div>' + colIzquierda + '</div>' +
      '<div>' + colDerecha   + '</div>' +
    '</div>' +

    // Panel de verificación (oculto hasta que se dispare)
    '<div class="card" id="verificacionPanel" style="display:none">' +
      '<div class="card-title">Verificación de Insumos</div>' +
      '<div id="verificacionBody"></div>' +
    '</div>';
}

// ——— TABLA DE DETALLES ———
// Muestra columna p.N (numero_pedido). Una fila por línea — sin fusión.

function renderDetallesRows(detalles, editable) {
  if (!detalles.length) {
    return '<tr><td colspan="' + (editable ? 5 : 4) + '" ' +
      'style="text-align:center;color:var(--text3);padding:20px">Sin líneas — agregá productos arriba</td></tr>';
  }
  return detalles.map(d =>
    '<tr>' +
      // p.N
      '<td style="text-align:center;color:var(--text3);font-size:11px;font-family:var(--font-head);font-weight:700">' +
        'p.' + d.numero_pedido +
      '</td>' +
      '<td><strong>' + escHtml(d.producto_nombre) + '</strong></td>' +
      '<td>' + d.talle + '</td>' +
      '<td>' +
        (editable
          ? '<input type="number" value="' + d.cantidad + '" min="1" ' +
            'style="width:64px;padding:4px 6px;background:var(--bg3);border:1px solid var(--border2);' +
            'border-radius:3px;color:var(--text);text-align:center" ' +
            'onchange="actualizarDetalleOrden(' + d.id + ', this.value)" />'
          : '<strong>' + d.cantidad + '</strong>') +
      '</td>' +
      (editable
        ? '<td><button class="btn btn-sm btn-danger" onclick="eliminarDetalleOrden(' + d.id + ')" aria-label="Eliminar línea" title="Eliminar línea">✕</button></td>'
        : '') +
    '</tr>'
  ).join('');
}

// ——— FORMULARIO AGREGAR BLOQUE ———
// Al seleccionar producto se despliega tabla de todos sus talles.
// Cada talle del bulk se convierte en una fila independiente con su numero_pedido.

function buildAddBloqueForm(productos) {
  const opts = productos.map(p =>
    '<option value="' + p.id + '" data-talles="' + (p.talles || []).join(',') + '">' +
      escHtml(p.nombre) +
    '</option>'
  ).join('');

  return (
    '<div class="form-group">' +
      '<label class="form-label">Producto</label>' +
      '<select class="form-select" id="nlProducto" onchange="onNlProductoChange()">' +
        '<option value="">— Seleccionar producto —</option>' + opts +
      '</select>' +
    '</div>' +
    '<div class="form-group">' +
      '<label class="form-label">Número de pedido (opcional)</label>' +
      '<input type="number" id="nlNumeroPedido" class="form-input" min="1" placeholder="Ej: 27" />' +
    '</div>' +
    '<div id="nlTallesWrap" style="display:none">' +
      '<div style="margin-bottom:6px;font-size:11px;color:var(--text3)">' +
        'Los talles que cargues juntos comparten el mismo número de pedido (p.N) dentro de la planilla.' +
      '</div>' +
      '<div id="nlTallesGrid" style="margin-bottom:12px"></div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn btn-primary" onclick="agregarBloqueOrden()">+ Agregar a la planilla</button>' +
        '<button class="btn btn-ghost"   onclick="limpiarFormOrden()">Limpiar</button>' +
      '</div>' +
    '</div>'
  );
}

function onNlProductoChange() {
  const sel    = document.getElementById('nlProducto');
  const opt    = sel.selectedOptions[0];
  const talles = opt && opt.value ? (opt.dataset.talles || '').split(',').filter(Boolean) : [];
  const wrap   = document.getElementById('nlTallesWrap');
  const grid   = document.getElementById('nlTallesGrid');

  if (!talles.length) { wrap.style.display = 'none'; return; }

  grid.innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(82px,1fr));gap:8px">' +
    talles.map(t =>
      '<div class="stock-talle-cell">' +
        '<label>' + t + '</label>' +
        '<input type="number" id="nlQty_' + t + '" value="0" min="0" ' +
          'style="text-align:center" ' +
          'onfocus="if(this.value===\'0\')this.value=\'\'" ' +
          'onblur="if(this.value===\'\')this.value=\'0\'" ' +
          'oninput="hlTalle(\'' + t + '\',this.value)" />' +
      '</div>'
    ).join('') +
    '</div>';

  wrap.style.display = '';
}

function hlTalle(t, val) {
  const inp = document.getElementById('nlQty_' + t);
  if (!inp) return;
  const pos = parseInt(val) > 0;
  inp.style.borderColor = pos ? 'var(--accent)' : 'var(--border2)';
  inp.style.color       = pos ? 'var(--accent)' : 'var(--text)';
  inp.style.fontWeight  = pos ? '700' : '400';
}

function limpiarFormOrden() {
  const sel = document.getElementById('nlProducto');
  if (sel) sel.value = '';
  const wrap = document.getElementById('nlTallesWrap');
  if (wrap) wrap.style.display = 'none';
}

async function agregarBloqueOrden() {
  const sel    = document.getElementById('nlProducto');
  const prodId = sel ? sel.value : '';
  const opt    = sel ? sel.selectedOptions[0] : null;
  const talles = opt && opt.value ? (opt.dataset.talles || '').split(',').filter(Boolean) : [];

  if (!prodId) { toast('Seleccioná un producto', 'error'); return; }

  const lineas = [];
  for (const t of talles) {
    const qty = parseInt(document.getElementById('nlQty_' + t)?.value) || 0;
    if (qty > 0) lineas.push({ talle: t, cantidad: qty });
  }
  if (!lineas.length) { toast('Ingresá al menos una cantidad > 0', 'error'); return; }

  try {
    const numeroPedido = parseInt(
      document.getElementById('nlNumeroPedido')?.value
    ) || null;

    await API.ordenes.addDetallesBulk(_ordenActual.id, {
      producto_id: Number(prodId),
      lineas,
      numero_pedido: numeroPedido
    });
    toast(lineas.length + ' línea' + (lineas.length !== 1 ? 's' : '') + ' agregada' + (lineas.length !== 1 ? 's' : ''), 'success');
    limpiarFormOrden();
    // Recargar detalle completo para reflejar nuevos numero_pedido y vistas previas
    await renderOrdenDetalle(_ordenActual.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ——— ACCIONES SOBRE DETALLES INDIVIDUALES ———

async function actualizarDetalleOrden(detalleId, cantidad) {
  const qty = parseInt(cantidad);
  if (isNaN(qty) || qty < 1) { toast('Cantidad inválida', 'error'); return; }
  try {
    await API.ordenes.updateDetalle(detalleId, { cantidad: qty });
    toast('Cantidad actualizada', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function eliminarDetalleOrden(detalleId) {
  try {
    await API.ordenes.deleteDetalle(detalleId);
    toast('Línea eliminada', 'success');
    await renderOrdenDetalle(_ordenActual.id);
  } catch (e) { toast(e.message, 'error'); }
}

// ——— ACCIONES DE ORDEN ———

async function confirmarOrdenActual() {
  if (!_ordenActual) return;
  if (!confirmAction('¿Confirmar planilla?\nSe descontará stock automáticamente.\nSi no alcanza quedará en negativo.')) return;
  try {
    await API.ordenes.confirmar(_ordenActual.id);
    toast('Planilla confirmada — stock descontado', 'success');
    renderOrdenDetalle(_ordenActual.id);
  } catch (e) { toast(e.message, 'error'); }
}

async function cancelarOrdenActual() {
  if (!_ordenActual) return;
  if (!confirmAction('¿Cancelar esta planilla?')) return;
  try {
    await API.ordenes.cancelar(_ordenActual.id);
    toast('Planilla cancelada', 'success');
    renderOrdenes();
  } catch (e) { toast(e.message, 'error'); }
}

// Compatibilidad con llamadas externas
async function confirmarOrden(id) {
  const target = id || (_ordenActual && _ordenActual.id);
  if (!target) return;
  if (!confirmAction('¿Confirmar planilla?')) return;
  try {
    await API.ordenes.confirmar(target);
    toast('Planilla confirmada', 'success');
    renderOrdenDetalle(target);
  } catch (e) { toast(e.message, 'error'); }
}

async function cancelarOrden(id) {
  const target = id || (_ordenActual && _ordenActual.id);
  if (!target) return;
  if (!confirmAction('¿Cancelar esta planilla?')) return;
  try {
    await API.ordenes.cancelar(target);
    toast('Planilla cancelada', 'success');
    renderOrdenes();
  } catch (e) { toast(e.message, 'error'); }
}

// ——— VERIFICACIÓN (accordion por línea) ———
// El backend ya recibe detalles ORDER BY numero_pedido y descuenta virtualmente.

async function verificarOrden() {
  if (!_ordenActual) return;
  const panel = document.getElementById('verificacionPanel');
  const body  = document.getElementById('verificacionBody');
  if (!panel || !body) return;

  panel.style.display = 'block';
  body.innerHTML = '<em style="color:var(--text2)">Verificando stock (consumo acumulado línea a línea)...</em>';
  panel.scrollIntoView({ behavior: 'smooth' });

  try {
    const bloques = await API.ordenes.verificar(_ordenActual.id);

    if (!bloques.length) {
      body.innerHTML = emptyState('Sin insumos para verificar');
      return;
    }

    const hayFaltante = bloques.some(b => b.insumos.some(i => i.faltante > 0));

    let html =
      '<div class="badge ' + (hayFaltante ? 'badge-red' : 'badge-green') +
      '" style="margin-bottom:16px;font-size:12px">' +
      (hayFaltante
        ? '⚠ Hay faltantes — podés confirmar igual, el stock quedará en negativo'
        : '✓ Stock suficiente para toda la planilla') +
      '</div>';

    bloques.forEach((bloque, idx) => {
      const bloqueConFaltante = bloque.insumos.some(i => i.faltante > 0);
      const accId = 'acc_' + idx;

      const filas = bloque.insumos.map(ins => {
        const tipoLabel = {
          plantilla: '<span class="badge badge-blue">plantilla</span>',
          fondo:     '<span class="badge badge-gold">fondo</span>',
          cierre:    '<span class="badge badge-gray">cierre</span>',
          hebilla:   '<span class="badge badge-gray">hebilla</span>',
        }[ins.tipo] || '<span class="badge badge-gray">' + ins.tipo + '</span>';

        return '<tr>' +
          '<td>' + tipoLabel + '</td>' +
          '<td>' + escHtml(ins.nombre) + '</td>' +
          '<td style="text-align:center">' + (ins.talle || '—') + '</td>' +
          '<td style="text-align:center" class="' + (ins.stock_actual < 0 ? 'text-red bold' : 'text-green') + '">' +
            ins.stock_actual +
          '</td>' +
          '<td style="text-align:center"><strong>' + ins.stock_virtual + '</strong>' +
            ' <span style="color:var(--text3);font-size:10px">(disp.)</span></td>' +
          '<td style="text-align:center">' + ins.necesario + '</td>' +
          '<td style="text-align:center" class="' + (ins.faltante > 0 ? 'text-red bold' : 'text-green') + '">' +
            (ins.faltante > 0 ? '⚠ ' + ins.faltante : '✓') +
          '</td>' +
        '</tr>';
      }).join('');

      html +=
        '<div style="border:1px solid var(--border2);border-radius:4px;margin-bottom:8px;overflow:hidden">' +
          '<div style="padding:10px 14px;background:var(--bg3);cursor:pointer;display:flex;align-items:center;gap:10px;user-select:none"' +
               ' onclick="toggleAcc(\'' + accId + '\')">' +
            '<span style="font-family:var(--font-head);font-weight:700;color:var(--text2);font-size:12px;min-width:32px">p.' + bloque.numero_pedido + '</span>' +
            '<span style="font-family:var(--font-head);font-weight:700">' + escHtml(bloque.producto_nombre) + '</span>' +
            '<span class="text-muted" style="font-size:12px">T' + bloque.talle_orden + ' × ' + bloque.cantidad_pares + ' pares</span>' +
            '<span class="badge ' + (bloqueConFaltante ? 'badge-red' : 'badge-green') + '" style="margin-left:auto">' +
              (bloqueConFaltante ? 'Faltante' : 'OK') +
            '</span>' +
            '<span id="' + accId + '_icon" style="color:var(--text2)">▼</span>' +
          '</div>' +
          '<div id="' + accId + '" style="display:none;overflow-x:auto">' +
            '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
              '<thead style="background:var(--bg3)">' +
                '<tr>' +
                  '<th style="padding:6px 10px;text-align:left;border-bottom:1px solid var(--border2)">Tipo</th>' +
                  '<th style="padding:6px 10px;text-align:left;border-bottom:1px solid var(--border2)">Insumo</th>' +
                  '<th style="padding:6px 10px;text-align:center;border-bottom:1px solid var(--border2)">Talle</th>' +
                  '<th style="padding:6px 10px;text-align:center;border-bottom:1px solid var(--border2)">Stock real</th>' +
                  '<th style="padding:6px 10px;text-align:center;border-bottom:1px solid var(--border2)">Disponible</th>' +
                  '<th style="padding:6px 10px;text-align:center;border-bottom:1px solid var(--border2)">Necesario</th>' +
                  '<th style="padding:6px 10px;text-align:center;border-bottom:1px solid var(--border2)">Faltante</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody>' + filas + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>';
    });

    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = '<span class="text-red">' + escHtml(e.message) + '</span>';
  }
}

function toggleAcc(id) {
  const el   = document.getElementById(id);
  const icon = document.getElementById(id + '_icon');
  if (!el) return;
  const open = el.style.display === 'none';
  el.style.display = open ? 'block' : 'none';
  if (icon) icon.textContent = open ? '▲' : '▼';
}

// ——— CREAR ORDEN ———

function modalCrearOrden() {
  Modal.open('Nueva planilla de corte',
    '<div class="form-group">' +
      '<label class="form-label" for="orDescripcion">Descripción (opcional)</label>' +
      '<input class="form-input" id="orDescripcion" placeholder="Ej: Corte semana 20" />' +
    '</div>' +
    '<div class="modal-footer">' +
      '<button class="btn" onclick="Modal.close()">Cancelar</button>' +
      '<button class="btn btn-primary" onclick="crearOrden()">Crear</button>' +
    '</div>'
  );
}

async function crearOrden() {
  const desc = document.getElementById('orDescripcion').value.trim() || null;
  try {
    const { id } = await API.ordenes.create({ descripcion: desc });
    toast('Planilla creada', 'success');
    Modal.close();
    renderOrdenDetalle(id);
  } catch (e) { toast(e.message, 'error'); }
}

function imprimirOrden(id) {
  window.open(API.ordenes.pdfUrl(id), '_blank');
}

// ——— VISTAS PREVIAS ———
// Una fila por detalle (no se agrupan por producto_id).
// Nombre muestra "Producto (p.N)".
// Los detalles llegan ORDER BY numero_pedido desde el backend.

function renderSheetFondos(detalles) {
  if (!detalles.length) return emptyState('Sin líneas');

  const grupos = {};

  detalles.forEach(d => {
    if (!grupos[d.numero_pedido]) {
      grupos[d.numero_pedido] = {
        ...d,
        talles: {},
        total: 0
      };
    }

    grupos[d.numero_pedido].talles[d.talle] = d.cantidad;
    grupos[d.numero_pedido].total += d.cantidad;
  });

  const ths = TALLES_CALZADO.map(t =>
    '<th style="padding:4px 5px;text-align:center;border:1px solid var(--border2);min-width:26px">' + t + '</th>'
  ).join('');

  const rows = Object.values(grupos).map((d, i) => {
    const fondoIns = (typeof _insumosCache !== 'undefined')
      ? _insumosCache.find(ins => ins.id === d.fondo_id)
      : null;

    const fondoDisplay = fondoIns && fondoIns.color
      ? d.fondo_nombre + ' (' + fondoIns.color + ')'
      : d.fondo_nombre;

    const nombreDisplay = d.producto_nombre + ' (p.' + d.numero_pedido + ')';

    const tds = TALLES_CALZADO.map(t => {
      const qty = d.talles[t] || 0;

      return '<td style="padding:4px 5px;text-align:center;border:1px solid var(--border2)">' +
        (qty > 0
          ? '<strong style="color:var(--text)">' + qty + '</strong>'
          : '<span style="color:var(--border2)">·</span>') +
      '</td>';
    }).join('');

    return '<tr style="background:' + (i % 2 === 0 ? 'transparent' : 'var(--bg3)') + '">' +
      '<td style="padding:4px 5px;text-align:center;border:1px solid var(--border2);font-weight:700;color:var(--text3);font-size:10px;min-width:30px">' +
        'p.' + d.numero_pedido +
      '</td>' +
      '<td style="padding:4px 5px;text-align:center;border:1px solid var(--border2);font-weight:700;color:var(--accent);min-width:32px">' +
        d.total +
      '</td>' +
      '<td style="padding:4px 8px;border:1px solid var(--border2);font-weight:600">' +
        escHtml(nombreDisplay) +
      '</td>' +
      '<td style="padding:4px 8px;border:1px solid var(--border2);color:var(--text2)">' +
        escHtml(fondoDisplay) +
      '</td>' +
      tds +
    '</tr>';
  }).join('');

  return '<table style="border-collapse:collapse;font-size:11px;width:100%">' +
    '<thead><tr style="background:var(--bg3)">' +
      '<th style="padding:5px 5px;text-align:center;border:1px solid var(--border2);min-width:30px">P.</th>' +
      '<th style="padding:5px 5px;text-align:center;border:1px solid var(--border2);min-width:32px">Tot</th>' +
      '<th style="padding:5px 8px;text-align:left;border:1px solid var(--border2)">Producto</th>' +
      '<th style="padding:5px 8px;text-align:left;border:1px solid var(--border2)">Fondo</th>' +
      ths +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
  '</table>';
}

function renderSheetPlantillas(detalles) {
  if (!detalles.length) return emptyState('Sin líneas');

  const grupos = {};

  detalles.forEach(d => {
    if (!grupos[d.numero_pedido]) {
      grupos[d.numero_pedido] = {
        ...d,
        talles: {},
        total: 0
      };
    }

    grupos[d.numero_pedido].talles[d.talle] = d.cantidad;
    grupos[d.numero_pedido].total += d.cantidad;
  });

  const ths = TALLES_CALZADO.map(t =>
    '<th style="padding:4px 5px;text-align:center;border:1px solid var(--border2);min-width:26px">' + t + '</th>'
  ).join('');

  const rows = Object.values(grupos).map((d, i) => {
    const prod = _productosCache.find(p => p.id === d.producto_id);
    const cierre = prod?.accesorios?.find(a => a.tipo === 'cierre');
    const hebilla = prod?.accesorios?.find(a => a.tipo === 'hebilla');

    const nombreDisplay = d.producto_nombre + ' (p.' + d.numero_pedido + ')';

    const cierreNombre = cierre
      ? escHtml(cierre.insumo_nombre) + (cierre.color ? ' (' + cierre.color + ')' : '')
      : '—';

    const hebillaNombre = hebilla
      ? escHtml(hebilla.insumo_nombre) + (hebilla.color ? ' (' + hebilla.color + ')' : '')
      : '—';

    const tds = TALLES_CALZADO.map(t => {
      const qty = d.talles[t] || 0;

      return '<td style="padding:4px 5px;text-align:center;border:1px solid var(--border2)">' +
        (qty > 0
          ? '<strong>' + qty + '</strong>'
          : '<span style="color:var(--border2)">·</span>') +
      '</td>';
    }).join('');

    return '<tr style="background:' + (i % 2 === 0 ? 'transparent' : 'var(--bg3)') + '">' +
      '<td style="padding:4px 5px;text-align:center;border:1px solid var(--border2);font-weight:700;color:var(--text3);font-size:10px;min-width:30px">' +
        'p.' + d.numero_pedido +
      '</td>' +
      '<td style="padding:4px 5px;text-align:center;border:1px solid var(--border2);font-weight:700;color:var(--accent);min-width:32px">' +
        d.total +
      '</td>' +
      '<td style="padding:4px 8px;border:1px solid var(--border2);font-weight:600">' +
        escHtml(nombreDisplay) +
      '</td>' +
      '<td style="padding:4px 8px;border:1px solid var(--border2);color:var(--text2)">' +
        escHtml(d.plantilla_nombre) +
      '</td>' +
      tds +
      '<td style="padding:4px 6px;border:1px solid var(--border2);font-size:10px;' +
        (cierre ? '' : 'color:var(--text3)') + '">' +
        cierreNombre +
      '</td>' +
      '<td style="padding:4px 5px;text-align:center;border:1px solid var(--border2);font-weight:' +
        (cierre ? '700' : '400') + ';color:' +
        (cierre ? 'var(--gold)' : 'var(--text3)') + '">' +
        (cierre ? cierre.cantidad_por_par * d.total : '—') +
      '</td>' +
      '<td style="padding:4px 6px;border:1px solid var(--border2);font-size:10px;' +
        (hebilla ? '' : 'color:var(--text3)') + '">' +
        hebillaNombre +
      '</td>' +
      '<td style="padding:4px 5px;text-align:center;border:1px solid var(--border2);font-weight:' +
        (hebilla ? '700' : '400') + ';color:' +
        (hebilla ? 'var(--gold)' : 'var(--text3)') + '">' +
        (hebilla ? hebilla.cantidad_por_par * d.total : '—') +
      '</td>' +
    '</tr>';
  }).join('');

  return '<table style="border-collapse:collapse;font-size:11px;width:100%">' +
    '<thead><tr style="background:var(--bg3)">' +
      '<th style="padding:5px 5px;text-align:center;border:1px solid var(--border2);min-width:30px">P.</th>' +
      '<th style="padding:5px 5px;text-align:center;border:1px solid var(--border2);min-width:32px">Tot</th>' +
      '<th style="padding:5px 8px;text-align:left;border:1px solid var(--border2)">Producto</th>' +
      '<th style="padding:5px 8px;text-align:left;border:1px solid var(--border2)">Plantilla</th>' +
      ths +
      '<th style="padding:5px 6px;border:1px solid var(--border2)">Cierre</th>' +
      '<th style="padding:5px 5px;text-align:center;border:1px solid var(--border2)">Cant</th>' +
      '<th style="padding:5px 6px;border:1px solid var(--border2)">Hebilla</th>' +
      '<th style="padding:5px 5px;text-align:center;border:1px solid var(--border2)">Cant</th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
  '</table>';
}