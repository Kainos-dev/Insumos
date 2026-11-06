// ============================================================
// pages/dashboard.js — Espacio "Fábrica" (vista general)
// Usa únicamente los datos existentes de /api/dashboard.
// ============================================================

const FAB_ALERTAS = [
  { clave: 'faltantes',  label: 'Faltantes',  vacio: 'Sin faltantes: ningún insumo tiene stock negativo.' },
  { clave: 'sin_stock',  label: 'Sin stock',  vacio: 'Ningún talle habilitado ni stock general está en cero.' },
  { clave: 'stock_bajo', label: 'Stock bajo', vacio: 'Ningún insumo está en o bajo su mínimo.' },
];
let _fabAlertas = { faltantes: [], sin_stock: [], stock_bajo: [] };

async function renderDashboard(sub) {
  if (sub === 'asignaciones') return renderAsignaciones();
  setPageTitle('Fábrica');
  setTopbarActions(`
    <button class="btn btn-sm" onclick="router.go('fabrica','asignaciones')">Asignar responsables</button>
    <button class="btn btn-sm btn-ghost" onclick="renderDashboard()">↻ Actualizar</button>`);
  loading();

  const data = await API.dashboard();
  const { totales, stock_bajo, faltantes, ordenes_recientes, pedidos_pendientes } = data;
  const sin_stock = data.sin_stock || [];
  const avisos = data.avisos || { conciliacion: [], sin_talles: [] };
  const resp = data.responsables || { disponible: false };
  const diag = resp.disponible ? await API.responsables.diagnostico().catch(() => null) : null;
  _fabAlertas = { faltantes, sin_stock, stock_bajo };

  const pedidosIncompatibles = diag ? diag.mezcla.length + diag.desalineado.length : 0;
  const respCard = !resp.disponible
    ? `<div style="padding:12px var(--pad)">${avisoMigracionPendiente()}</div>`
    : `<div class="resp-list">
        ${resp.lista.map(r => {
          const e = getEspacio(r.slug) || {};
          const partes = [`${r.insumos_asignados} insumo${r.insumos_asignados === 1 ? '' : 's'}`];
          if (r.faltantes) partes.push(`<span class="text-red">${r.faltantes} faltante${r.faltantes === 1 ? '' : 's'}</span>`);
          if (r.sin_stock) partes.push(`<span class="text-orange">${r.sin_stock} sin stock</span>`);
          if (r.stock_bajo) partes.push(`<span class="text-gold">${r.stock_bajo} bajo</span>`);
          if (r.pedidos_pendientes) partes.push(`${r.pedidos_pendientes} pedido${r.pedidos_pendientes === 1 ? '' : 's'}`);
          return `
            <a class="resp-row" href="#espacio/${r.slug}">
              <span class="nav-avatar" style="--avatar:${e.color || 'var(--text3)'}" aria-hidden="true">${escHtml(e.inicial || r.nombre[0])}</span>
              <span><span class="resp-name">${escHtml(r.nombre)}</span>
                <span class="resp-meta"> · ${partes.join(' · ')}</span></span>
              <span class="resp-go" aria-hidden="true">→</span>
            </a>`;
        }).join('')}
        <a class="resp-row" href="#fabrica/asignaciones">
          <span class="nav-avatar" style="--avatar:var(--bg4);color:var(--text2)" aria-hidden="true">?</span>
          <span><span class="resp-name">Sin asignar</span>
            <span class="resp-meta"> · ${resp.sin_asignar.length} insumo${resp.sin_asignar.length === 1 ? '' : 's'}</span></span>
          <span class="resp-go" aria-hidden="true">Asignar →</span>
        </a>
      </div>`;

  const listaNombres = (items) => items.map(i => escHtml(i.nombre)).join(', ');
  const avisosHtml = (avisos.conciliacion.length || avisos.sin_talles.length || pedidosIncompatibles) ? `
    <div class="notice notice--warn" role="status">
      <span class="notice-icon" aria-hidden="true">▲</span>
      <div>
        <strong>Revisión pendiente</strong>
        ${avisos.conciliacion.length ? `<p>${avisos.conciliacion.length} insumo(s) con stock duplicado de un error anterior; requieren conteo físico y conciliación: ${listaNombres(avisos.conciliacion)}.</p>` : ''}
        ${avisos.sin_talles.length ? `<p>${avisos.sin_talles.length} plantilla(s)/fondo(s) sin talles habilitados: no generan alertas de sin stock ni de stock bajo (los negativos sí se muestran): ${listaNombres(avisos.sin_talles)}.</p>` : ''}
        ${pedidosIncompatibles ? `<p>${pedidosIncompatibles} pedido(s) con insumos de distintos responsables según las asignaciones actuales (no se modificaron): ${[...diag.mezcla, ...diag.desalineado].map(p => '#' + p.id).join(', ')}.</p>` : ''}
      </div>
    </div>` : '';

  const kpi = (label, value, cls = '', hint = '') => `
    <div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value ${cls}">${value}</div>
      ${hint ? `<div class="kpi-hint">${hint}</div>` : ''}
    </div>`;

  const html = `
    <div class="kpi-strip">
      ${kpi('Faltantes', faltantes.length, faltantes.length ? 'text-red' : '', 'stock negativo')}
      ${kpi('Sin stock', sin_stock.length, sin_stock.length ? 'text-orange' : '', 'en cero')}
      ${kpi('Stock bajo', stock_bajo.length, stock_bajo.length ? 'text-gold' : '', 'hasta el mínimo')}
      ${resp.disponible ? kpi('Sin responsable', resp.sin_asignar.length, resp.sin_asignar.length ? 'text-gold' : '', 'insumos') : ''}
      ${kpi('Planillas en borrador', totales.ordenes_borrador)}
      ${kpi('Pedidos pendientes', pedidos_pendientes.length)}
      ${kpi('Insumos', totales.insumos)}
    </div>

    ${avisosHtml}

    <div class="grid-main">
      <div class="card card--flush">
        <div class="card-head">
          <div class="card-title">Alertas de inventario</div>
          <div class="segmented" role="tablist" aria-label="Tipo de alerta">
            ${FAB_ALERTAS.map(a => `
              <button role="tab" id="tab_${a.clave}" aria-selected="false" onclick="fabMostrarAlertas('${a.clave}')">
                ${a.label} <span class="tab-count">${_fabAlertas[a.clave].length}</span></button>`).join('')}
          </div>
        </div>
        <div id="fabAlertas"></div>
      </div>

      <div class="card card--flush">
        <div class="card-head">
          <div class="card-title">Responsables de reposición</div>
          ${resp.disponible ? `<button class="btn btn-sm btn-ghost" onclick="router.go('fabrica','asignaciones')">Asignar →</button>` : ''}
        </div>
        ${respCard}
      </div>
    </div>

    <div class="card" style="margin-top:var(--gap)">
      <div class="card-title">Movimiento rápido de stock</div>
      <div class="quick-stock-panel" id="quickStockPanel"><span class="text-muted">Cargando insumos…</span></div>
    </div>

    <div class="two-col">
      <div class="card card--flush">
        <div class="card-head">
          <div class="card-title">Planillas de corte recientes</div>
          <button class="btn btn-sm btn-ghost" onclick="router.go('planillas')">Ver todas →</button>
        </div>
        ${ordenes_recientes.length === 0
          ? emptyState('Sin planillas de corte')
          : `<div class="table-wrap"><table>
            <thead><tr><th>N.º</th><th>Descripción</th><th>Estado</th><th class="num">Pares</th><th>Fecha</th></tr></thead>
            <tbody>
              ${ordenes_recientes.map(o => `
                <tr style="cursor:pointer" onclick="router.go('planillas','${o.id}')">
                  <td class="text-muted">#${o.id}</td>
                  <td>${escHtml(o.descripcion || '—')}</td>
                  <td>${estadoBadge(o.estado)}</td>
                  <td class="num">${o.total_pares || 0}</td>
                  <td class="text-muted nowrap">${formatDate(o.created_at)}</td>
                </tr>`).join('')}
            </tbody>
          </table></div>`}
      </div>

      <div class="card card--flush">
        <div class="card-head">
          <div class="card-title">Pedidos pendientes</div>
          <button class="btn btn-sm btn-ghost" onclick="router.go('pedidos')">Ver todos →</button>
        </div>
        ${pedidos_pendientes.length === 0
          ? emptyState('Sin pedidos pendientes')
          : `<div class="table-wrap"><table>
            <thead><tr><th>N.º</th><th>Proveedor</th><th>Estado</th><th>Fecha</th></tr></thead>
            <tbody>
              ${pedidos_pendientes.map(p => `
                <tr style="cursor:pointer" onclick="router.go('pedidos','${p.id}')">
                  <td class="text-muted">#${p.id}</td>
                  <td>${escHtml(p.proveedor_nombre)}</td>
                  <td>${estadoBadge(p.estado)}</td>
                  <td class="text-muted nowrap">${formatDate(p.created_at)}</td>
                </tr>`).join('')}
            </tbody>
          </table></div>`}
      </div>
    </div>
  `;

  document.getElementById('pageBody').innerHTML = html;
  // Se abre la primera categoría con alertas (por gravedad)
  const inicial = FAB_ALERTAS.find(a => _fabAlertas[a.clave].length) || FAB_ALERTAS[0];
  fabMostrarAlertas(inicial.clave);
  await renderQuickStock();
}

function fabMostrarAlertas(tipo) {
  const lista = _fabAlertas[tipo] || [];
  for (const a of FAB_ALERTAS) {
    const b = document.getElementById('tab_' + a.clave);
    if (b) { b.classList.toggle('active', a.clave === tipo); b.setAttribute('aria-selected', String(a.clave === tipo)); }
  }
  const cont = document.getElementById('fabAlertas');
  if (!cont) return;
  if (!lista.length) {
    cont.innerHTML = emptyState((FAB_ALERTAS.find(a => a.clave === tipo) || FAB_ALERTAS[0]).vacio);
    return;
  }
  cont.innerHTML = `<div class="table-wrap table-scroll"><table>
    <thead><tr><th>Insumo</th><th>Talle</th><th class="num">Stock</th><th class="num">Mínimo</th><th>Estado</th><th class="hide-sm">Proveedor</th></tr></thead>
    <tbody>${lista.map(a => `
      <tr>
        <td>${escHtml(a.nombre)}
          ${a.conciliacion_pendiente ? '<span class="badge badge-gold" title="Stock duplicado pendiente de conciliación">Conciliar</span>' : ''}</td>
        <td class="text-muted nowrap">${a.talle ? escHtml(a.talle) : '—'}
          ${a.talle && !a.talle_habilitado ? '<span class="badge badge-gray" title="Este talle no está habilitado para el insumo">no habilitado</span>' : ''}</td>
        <td class="num ${a.stock < 0 ? 'text-red' : ''}">${a.stock}</td>
        <td class="num text-muted">${a.stock_minimo}</td>
        <td>${stockBadge(a.stock, a.stock_minimo)}</td>
        <td class="text-muted hide-sm">${escHtml(a.proveedor_nombre || '—')}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
}

async function renderQuickStock() {
  const panel = document.getElementById('quickStockPanel');
  if (!panel) return;
  const insumos = await API.insumos.list();

  panel.innerHTML = `
    <div class="quick-stock-controls">
      <div class="form-group" style="flex:3 1 220px">
        <label class="form-label" for="qsInsumo">Insumo</label>
        <select class="form-select" id="qsInsumo" onchange="onQsInsumoChange()">
          <option value="">— Seleccionar —</option>
          ${insumos.map(i => `<option value="${i.id}" data-tipo="${i.tipo}">${escHtml(i.nombre)}</option>`).join('')}
        </select>
      </div>
      <div id="qsTalleWrap" style="display:none;flex:0 1 90px">
        <label class="form-label" for="qsTalle">Talle</label>
        <select class="form-select" id="qsTalle">
          ${TALLES_CALZADO.map(t => `<option value="${t}">${t}</option>`).join('')}
        </select>
      </div>
      <div style="flex:0 1 110px">
        <label class="form-label" for="qsCantidad">Cantidad</label>
        <input class="form-input" type="number" id="qsCantidad" value="1" min="0" step="1" />
      </div>
      <div style="flex:1 1 140px">
        <label class="form-label" for="qsTipo">Tipo</label>
        <select class="form-select" id="qsTipo">
          <option value="ingreso">Ingreso</option>
          <option value="egreso">Egreso</option>
          <option value="ajuste">Ajuste (fijar valor)</option>
        </select>
      </div>
      <div style="flex:0 0 auto">
        <button class="btn btn-primary" onclick="doQuickStock()">Registrar</button>
      </div>
    </div>
  `;
}

function onQsInsumoChange() {
  const sel = document.getElementById('qsInsumo');
  const opt = sel.selectedOptions[0];
  const tipo = opt ? opt.dataset.tipo : '';
  const wrap = document.getElementById('qsTalleWrap');
  wrap.style.display = (tipo === 'plantilla' || tipo === 'fondo') ? 'block' : 'none';
}

async function doQuickStock() {
  const insumo_id = document.getElementById('qsInsumo').value;
  const cantidad = parseInt(document.getElementById('qsCantidad').value);
  const tipo = document.getElementById('qsTipo').value;
  const talleEl = document.getElementById('qsTalle');
  const talleWrap = document.getElementById('qsTalleWrap');
  const talle = talleWrap.style.display !== 'none' ? talleEl.value : null;

  if (!insumo_id || Number.isNaN(cantidad)) { toast('Completar todos los campos', 'error'); return; }

  try {
    await API.movimientos.rapido({ insumo_id: Number(insumo_id), talle, cantidad, tipo });
    toast('Movimiento registrado', 'success');
    renderDashboard();
  } catch (e) {
    toast(e.message, 'error');
  }
}
