// ============================================================
// pages/pedidos.js
//
// Correcciones:
// 1. Botones Cancelar y Marcar Enviado funcionan correctamente
// 2. Flujo completo: borrador → enviado → recibido (suma stock)
// 3. Pantalla nueva de pedido inicia VACÍA (sin autocarga de faltantes)
// 4. Stock actual SIEMPRE visible al agregar insumos
// 5. Agrupación visual por modelo para plantillas/fondos con múltiples talles
// 6. WhatsApp sigue desglosado por talle
// ============================================================

// Cache para el modal de nuevo pedido
let _pedAllInsumos   = [];
let _pedProveedores  = [];

// ——— LISTADO ———

async function renderPedidos(subId) {
  setPageTitle('Pedidos a Proveedores');
  setTopbarActions('<button class="btn btn-primary" onclick="modalGenerarPedido()">+ Generar Pedido</button>');
  loading();

  if (subId) {
    await renderPedidoDetalle(Number(subId));
    return;
  }

  const pedidos = await API.pedidos.list();

  if (!pedidos.length) {
    document.getElementById('pageBody').innerHTML =
      '<div class="card">' + emptyState('Sin pedidos a proveedores') + '</div>';
    return;
  }

  let rows = '';
  for (const p of pedidos) {
    const btnEnviado  = p.estado === 'borrador'
      ? '<button class="btn btn-sm btn-primary" onclick="cambiarEstadoPedidoLista(' + p.id + ',\'enviado\')">Marcar Enviado</button>'
      : '';
    const btnRecibido = p.estado === 'enviado'
      ? '<button class="btn btn-sm btn-green" onclick="cambiarEstadoPedidoLista(' + p.id + ',\'recibido\')">Marcar Recibido</button>'
      : '';
    rows +=
      '<tr>' +
        '<td class="text-muted">#' + p.id + '</td>' +
        '<td><strong>' + escHtml(p.proveedor_nombre) + '</strong></td>' +
        '<td>' + (p.responsable_slug ? responsableChip({ slug: p.responsable_slug, nombre: p.responsable_nombre }) : '<span class="text-muted">—</span>') + '</td>' +
        '<td>' + estadoBadge(p.estado) + '</td>' +
        '<td>' + (p.total_unidades || 0) + '</td>' +
        '<td class="text-muted">' + formatDate(p.created_at) + '</td>' +
        '<td><div class="flex-gap">' +
          '<button class="btn btn-sm" onclick="renderPedidoDetalle(' + p.id + ')">Ver</button>' +
          btnEnviado + btnRecibido +
        '</div></td>' +
      '</tr>';
  }

  document.getElementById('pageBody').innerHTML =
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>#</th><th>Proveedor</th><th>Responsable</th><th>Estado</th>' +
    '<th>Unidades</th><th>Fecha</th><th>Acciones</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div></div>';
}

// Desde la lista (sin navigate)
async function cambiarEstadoPedidoLista(id, estado) {
  const msgs = {
    enviado:   '¿Marcar pedido como enviado?',
    recibido:  '¿Marcar como recibido? Se sumará el stock automáticamente.',
    cancelado: '¿Cancelar este pedido?',
  };
  if (!confirmAction(msgs[estado] || '¿Continuar?')) return;
  try {
    await API.pedidos.estado(id, estado);
    toast('Estado actualizado', 'success');
    renderPedidos();
  } catch (e) { toast(e.message, 'error'); }
}

// ——— DETALLE ———

async function renderPedidoDetalle(id) {
  loading();
  const pedido = await API.pedidos.get(id);

  // Agrupar detalles visualmente por insumo (nombre+modelo), mostrando talles agrupados
  const detallesHTML = renderDetallesAgrupados(pedido.detalles);

  const acciones = [];
  if (pedido.estado === 'borrador') {
    acciones.push('<button class="btn btn-primary" onclick="cambiarEstadoPedido(' + id + ',\'enviado\')">📤 Marcar como Enviado</button>');
  }
  if (pedido.estado === 'enviado') {
    acciones.push('<button class="btn btn-green" onclick="cambiarEstadoPedido(' + id + ',\'recibido\')">📦 Marcar como Recibido (suma stock)</button>');
  }
  if (pedido.estado === 'borrador' || pedido.estado === 'enviado') {
    acciones.push('<button class="btn btn-danger" onclick="cambiarEstadoPedido(' + id + ',\'cancelado\')">✕ Cancelar Pedido</button>');
  }

  const waMsg = pedido.mensaje_whatsapp || '—';
  const waMsgEsc = escHtml(waMsg);

  document.getElementById('pageBody').innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">' +
      '<button class="btn btn-sm btn-ghost" onclick="renderPedidos()">← Volver</button>' +
      '<h2 class="detail-title">' +
        'Pedido #' + pedido.id + ' — ' + escHtml(pedido.proveedor_nombre) +
      '</h2>' +
      estadoBadge(pedido.estado) +
      '<span class="text-muted text-small">Responsable: ' +
        (pedido.responsable_slug ? responsableChip({ slug: pedido.responsable_slug, nombre: pedido.responsable_nombre }) : 'sin asignar') +
      '</span>' +
    '</div>' +

    '<div class="two-col">' +
      '<div class="card">' +
        '<div class="card-title">Insumos Pedidos</div>' +
        detallesHTML +
      '</div>' +

      '<div>' +
        '<div class="card">' +
          '<div class="card-title">Estado del Pedido</div>' +
          '<div style="display:flex;flex-direction:column;gap:8px">' +
            acciones.join('') +
            (acciones.length === 0 ? '<span class="text-muted">Pedido ' + pedido.estado + '</span>' : '') +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-title">📱 Mensaje WhatsApp</div>' +
          '<div class="whatsapp-box">' + waMsgEsc + '</div>' +
          (waMsg !== '—'
            ? '<button class="btn btn-sm mt-8" onclick="copyWA()">Copiar mensaje</button>'
            : '') +
        '</div>' +
      '</div>' +
    '</div>';

  // Guardar el mensaje en variable global para el botón copiar
  window._waCurrentMsg = waMsg;
}

/**
 * Renderiza detalles agrupando visualmente plantillas y fondos por modelo
 * con sus talles listados, en lugar de una fila por talle.
 * Los cierres y hebillas (stock general) se muestran normalmente.
 */
function renderDetallesAgrupados(detalles) {
  if (!detalles.length) return emptyState('Sin insumos en este pedido');

  // Separar por tipo
  const conTalle    = detalles.filter(d => d.talle);    // plantillas y fondos
  const sinTalle    = detalles.filter(d => !d.talle);   // cierres y hebillas

  // Agrupar conTalle por insumo_id
  const gruposMap = new Map();
  for (const d of conTalle) {
    if (!gruposMap.has(d.insumo_id)) {
      gruposMap.set(d.insumo_id, {
        insumo_id:    d.insumo_id,
        insumo_nombre: d.insumo_nombre,
        tipo:         d.tipo,
        lineas:       [],
      });
    }
    gruposMap.get(d.insumo_id).lineas.push({ talle: d.talle, cantidad: d.cantidad });
  }

  let html = '<table style="width:100%;border-collapse:collapse;font-size:13px">';
  html += '<thead><tr>' +
    '<th style="padding:7px 10px;text-align:left;border-bottom:1px solid var(--border2)">Insumo</th>' +
    '<th style="padding:7px 10px;text-align:left;border-bottom:1px solid var(--border2)">Detalle</th>' +
    '<th style="padding:7px 10px;text-align:center;border-bottom:1px solid var(--border2)">Total</th>' +
  '</tr></thead><tbody>';

  // Grupos (plantillas / fondos) con talles agrupados
  for (const g of gruposMap.values()) {
    const total = g.lineas.reduce((s, l) => s + l.cantidad, 0);
    // Ordenar talles numéricamente
    g.lineas.sort((a, b) => parseInt(a.talle) - parseInt(b.talle));
    const tallesDetalle = g.lineas.map(l =>
      '<div style="font-size:11px;color:var(--text2)">' +
        '<span style="color:var(--text3)">T' + l.talle + '</span>' +
        ' → <strong style="color:var(--text)">' + l.cantidad + '</strong>' +
      '</div>'
    ).join('');

    html +=
      '<tr>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top">' +
          '<strong>' + escHtml(g.insumo_nombre) + '</strong><br>' +
          tipoBadge(g.tipo) +
        '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--border)">' + tallesDetalle + '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--border);text-align:center;font-weight:700;color:var(--accent)">' + total + '</td>' +
      '</tr>';
  }

  // Cierres y hebillas (sin talle)
  for (const d of sinTalle) {
    html +=
      '<tr>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--border)">' +
          '<strong>' + escHtml(d.insumo_nombre) + '</strong><br>' +
          tipoBadge(d.tipo) +
        '</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text3)">—</td>' +
        '<td style="padding:8px 10px;border-bottom:1px solid var(--border);text-align:center;font-weight:700;color:var(--accent)">' + d.cantidad + '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

function copyWA() {
  const msg = window._waCurrentMsg || '';
  navigator.clipboard.writeText(msg).then(() => toast('Mensaje copiado', 'success'));
}

async function cambiarEstadoPedido(id, estado) {
  const msgs = {
    enviado:   '¿Marcar pedido como enviado?',
    recibido:  '¿Marcar como recibido? Se sumará el stock automáticamente respetando talles.',
    cancelado: '¿Cancelar este pedido?',
  };
  if (!confirmAction(msgs[estado] || '¿Continuar?')) return;
  try {
    await API.pedidos.estado(id, estado);
    toast('Estado actualizado', 'success');
    renderPedidoDetalle(id);
  } catch (e) { toast(e.message, 'error'); }
}

// ——— MODAL NUEVO PEDIDO ———
// Inicia VACÍO. El usuario elige proveedor y agrega insumos manualmente.
// Stock actual siempre visible en cada línea.

let _pedResponsables = null;   // null: gestión de responsables no habilitada

async function modalGenerarPedido() {
  const [allInsumos, allProveedores, estResp] = await Promise.all([
    API.insumos.list(),
    API.proveedores.list(),
    API.responsables.estado(),
  ]);

  _pedAllInsumos  = allInsumos;
  _pedProveedores = allProveedores;
  _pedResponsables = estResp.disponible ? (await API.responsables.list()).responsables.filter(r => r.activo) : null;

  const provOpts = allProveedores.map(p =>
    '<option value="' + p.id + '">' + escHtml(p.nombre) + '</option>'
  ).join('');

  // Todo pedido nuevo tiene responsable obligatorio: se elige primero y solo
  // se ofrecen sus insumos. El servidor vuelve a validarlo.
  if (!_pedResponsables) {
    Modal.open('Generar Pedido a Proveedor', avisoMigracionPendiente('Los pedidos nuevos necesitan un responsable.') +
      '<div class="modal-footer"><button class="btn" onclick="Modal.close()">Cerrar</button></div>');
    return;
  }
  const respHtml =
    '<div class="form-group">' +
      '<label class="form-label" for="pedResponsableSel">Responsable *</label>' +
      '<select class="form-select" id="pedResponsableSel" onchange="onPedProveedorChange()">' +
        _pedResponsables.map(r => '<option value="' + r.id + '">' + escHtml(r.nombre) + '</option>').join('') +
      '</select>' +
      '<div class="form-hint">Todos los insumos del pedido deben estar asignados a este responsable.</div>' +
    '</div>';

  const html =
    '<div class="form-row">' +
    respHtml +
    '<div class="form-group">' +
      '<label class="form-label" for="pedProveedorSel">Proveedor *</label>' +
      '<select class="form-select" id="pedProveedorSel" onchange="onPedProveedorChange()">' +
        '<option value="">— Seleccionar proveedor —</option>' +
        provOpts +
      '</select>' +
    '</div>' +
    '</div>' +
    '<div id="pedLineas" style="margin-top:4px"></div>' +
    '<div style="margin-top:10px">' +
      '<button class="btn btn-sm" onclick="addPedidoLinea()" id="btnAddLinea" style="display:none">+ Agregar insumo</button>' +
    '</div>' +
    '<div class="modal-footer">' +
      '<button class="btn" onclick="Modal.close()">Cancelar</button>' +
      '<button class="btn btn-primary" onclick="crearPedido()">Generar Pedido</button>' +
    '</div>';

  Modal.open('Generar Pedido a Proveedor', html);
}

function onPedProveedorChange() {
  const provId = parseInt(document.getElementById('pedProveedorSel').value);
  const btn    = document.getElementById('btnAddLinea');
  const lineasEl = document.getElementById('pedLineas');

  if (!provId) {
    if (btn) btn.style.display = 'none';
    if (lineasEl) lineasEl.innerHTML = '';
    return;
  }

  if (btn) btn.style.display = '';
  if (lineasEl) lineasEl.innerHTML =
    '<div style="color:var(--text3);font-size:12px;padding:8px 0">Usá el botón para agregar insumos al pedido.</div>';
}

/**
 * Construye una fila de insumo para el pedido.
 * Muestra el stock actual al lado del selector, siempre visible.
 */
/** Responsable elegido en el formulario (obligatorio). */
function pedResponsableElegido() {
  const v = document.getElementById('pedResponsableSel')?.value;
  return v ? Number(v) : null;
}

function buildPedLinea(idx, provId) {
  const resp = pedResponsableElegido();
  const insumosDeEste = _pedAllInsumos.filter(i => i.proveedor_id === provId && i.responsable && i.responsable.id === resp);
  if (!insumosDeEste.length) {
    return '<div class="ped-linea text-muted text-small" style="padding:8px 0">' +
      'Este proveedor no tiene insumos asignados a ese responsable. Las asignaciones se hacen en Fábrica › Asignar responsables.</div>';
  }

  const opts = insumosDeEste.map(i =>
    '<option value="' + i.id + '" data-tipo="' + i.tipo + '">' +
      escHtml(i.nombre) + (i.color ? ' (' + i.color + ')' : '') +
    '</option>'
  ).join('');

  return `
    <div class="ped-linea"
      style="background:var(--bg3);border:1px solid var(--border2);border-radius:4px;padding:10px;margin-bottom:8px"
      data-idx="${idx}">

      <div style="display:flex;gap:8px;align-items:start">

        <div style="flex:1">

          <select class="form-select ped-insumo" onchange="onPedInsumoChange(this)">
            <option value="">— Insumo —</option>
            ${opts}
          </select>

          <div class="ped-stock-info" style="margin-top:8px"></div>

        </div>

        <button class="btn btn-sm btn-danger"
          onclick="this.closest('.ped-linea').remove()">
          ✕
        </button>

      </div>
    </div>
  `;
}

async function onPedInsumoChange(sel) {
  const insumoId = parseInt(sel.value);
  if (!insumoId) return;

  const linea = sel.closest('.ped-linea');
  const info = linea.querySelector('.ped-stock-info');

  const insumo = _pedAllInsumos.find(i => i.id === insumoId);
  if (!insumo) return;

  // cierres y hebillas → stock simple
  if (insumo.tipo === 'cierre' || insumo.tipo === 'hebilla') {
    info.innerHTML = `
      <div style="margin-top:8px">
        <input class="form-input ped-cantidad"
          type="number"
          min="1"
          value="1"
          placeholder="Cantidad" />
      </div>
    `;
    return;
  }

  // plantillas y fondos → carga masiva por talles habilitados
  const talles = insumo.talles || [];
const stockMap = {};

(insumo.stock_rows || []).forEach(r => {
  stockMap[r.talle] = r.stock;
});

info.innerHTML = `
  <div style="margin-top:10px">
    ${talles.map(t => {
      const stockActual = stockMap[t] ?? 0;

      return `
        <div style="display:grid;grid-template-columns:60px 120px 1fr;gap:8px;align-items:center;margin-bottom:6px">
          
          <div>
            <strong>T${t}</strong>
          </div>

          <input
            class="form-input ped-cantidad-talle"
            type="number"
            min="0"
            value="0"
            data-talle="${t}"
          />

          <div style="font-size:12px;color:var(--text2)">
            Stock actual: <strong>${stockActual}</strong>
          </div>

        </div>
      `;
    }).join('')}
  </div>
`;
}

function updateStockInfoPorTalle(info, talleEl, stockRows) {
  const talle    = talleEl?.value;
  const stockMap = {};
  for (const r of stockRows) stockMap[r.talle] = r.stock;

  if (!talle) {
    // Mostrar resumen de todos los talles
    const items = stockRows.map(r => {
      const color = r.stock < 0 ? 'color:var(--red)' : (r.stock <= 5 ? 'color:var(--gold)' : '');
      return 'T' + r.talle + ': <strong style="' + color + '">' + r.stock + '</strong>';
    }).join('  ');
    info.innerHTML = items || '<span style="color:var(--text3)">Sin stock registrado</span>';
  } else {
    const stock = stockMap[talle] ?? 0;
    const color = stock < 0 ? 'var(--red)' : (stock <= 5 ? 'var(--gold)' : 'var(--text2)');
    info.innerHTML = 'Stock T' + talle + ': <strong style="color:' + color + '">' + stock + '</strong>';
  }
}

function addPedidoLinea() {
  const provId   = parseInt(document.getElementById('pedProveedorSel')?.value);
  if (!provId) { toast('Seleccionar proveedor primero', 'error'); return; }
  const lineasEl = document.getElementById('pedLineas');
  if (!lineasEl) return;
  const idx = lineasEl.querySelectorAll('.ped-linea').length;
  lineasEl.insertAdjacentHTML('beforeend', buildPedLinea(idx, provId));
}

async function crearPedido() {
  const proveedor_id = parseInt(document.getElementById('pedProveedorSel')?.value);

  if (!proveedor_id) {
    toast('Seleccionar proveedor', 'error');
    return;
  }

  const rows = document.querySelectorAll('.ped-linea');
  const lineas = [];

  for (const row of rows) {
    const insumoEl = row.querySelector('.ped-insumo');
    const insumoId = parseInt(insumoEl?.value);

    if (!insumoId) continue;

    const insumo = _pedAllInsumos.find(i => i.id === insumoId);
    if (!insumo) continue;

    // stock general
    if (insumo.tipo === 'cierre' || insumo.tipo === 'hebilla') {
      const cantidad = parseInt(row.querySelector('.ped-cantidad')?.value) || 0;

      if (cantidad > 0) {
        lineas.push({
          insumo_id: insumoId,
          talle: null,
          cantidad
        });
      }
    }

    // stock por talle
    else {
      const inputs = row.querySelectorAll('.ped-cantidad-talle');

      for (const input of inputs) {
        const cantidad = parseInt(input.value) || 0;
        const talle = input.dataset.talle;

        if (cantidad > 0) {
          lineas.push({
            insumo_id: insumoId,
            talle,
            cantidad
          });
        }
      }
    }
  }

  if (!lineas.length) {
    toast('Agregar cantidades', 'error');
    return;
  }

  try {
    // El servidor valida que todos los insumos sean de este responsable
    const { id } = await API.pedidos.create({ proveedor_id, lineas, responsable_id: pedResponsableElegido() });
    toast('Pedido generado', 'success');
    Modal.close();
    renderPedidoDetalle(id);
  } catch (e) {
    toast(e.message, 'error');
  }
}
