// ============================================================
// pages/dashboard.js — Espacio "Fábrica" (vista general)
// Usa únicamente los datos existentes de /api/dashboard.
// ============================================================

let _fabAlertas = { faltantes: [], stock_bajo: [] };

async function renderDashboard() {
  setPageTitle('Fábrica');
  setTopbarActions(`<button class="btn btn-sm" onclick="renderDashboard()">↻ Actualizar</button>`);
  loading();

  const data = await API.dashboard();
  const { totales, stock_bajo, faltantes, ordenes_recientes, pedidos_pendientes } = data;
  _fabAlertas = { faltantes, stock_bajo };

  const kpi = (label, value, cls = '', hint = '') => `
    <div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value ${cls}">${value}</div>
      ${hint ? `<div class="kpi-hint">${hint}</div>` : ''}
    </div>`;

  const html = `
    <div class="kpi-strip">
      ${kpi('Faltantes', faltantes.length, faltantes.length ? 'text-red' : '', 'stock negativo')}
      ${kpi('Stock bajo', stock_bajo.length, stock_bajo.length ? 'text-gold' : '', 'en o bajo el mínimo')}
      ${kpi('Planillas en borrador', totales.ordenes_borrador)}
      ${kpi('Pedidos pendientes', pedidos_pendientes.length)}
      ${kpi('Insumos', totales.insumos)}
      ${kpi('Productos', totales.productos)}
      ${kpi('Proveedores', totales.proveedores)}
    </div>

    <div class="grid-main">
      <div class="card card--flush">
        <div class="card-head">
          <div class="card-title">Alertas de inventario</div>
          <div class="segmented" role="tablist" aria-label="Tipo de alerta">
            <button role="tab" id="tabFalt" class="active" aria-selected="true" onclick="fabMostrarAlertas('faltantes')">
              Faltantes <span class="tab-count">${faltantes.length}</span></button>
            <button role="tab" id="tabBajo" aria-selected="false" onclick="fabMostrarAlertas('stock_bajo')">
              Stock bajo <span class="tab-count">${stock_bajo.length}</span></button>
          </div>
        </div>
        <div id="fabAlertas"></div>
      </div>

      <div class="card card--flush">
        <div class="card-head">
          <div class="card-title">Responsables de reposición</div>
          <span class="badge badge-gray" title="La asignación todavía no está habilitada">${totales.insumos} sin asignar</span>
        </div>
        <div class="resp-list">
          ${ESPACIOS.map(e => `
            <a class="resp-row" href="#espacio/${e.slug}">
              <span class="nav-avatar" style="--avatar:${e.color}" aria-hidden="true">${e.inicial}</span>
              <span>
                <span class="resp-name">${escHtml(e.nombre)}</span>
                <span class="resp-meta"> · sin insumos asignados</span>
              </span>
              <span class="resp-go" aria-hidden="true">→</span>
            </a>`).join('')}
        </div>
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
  fabMostrarAlertas(faltantes.length || !stock_bajo.length ? 'faltantes' : 'stock_bajo');
  await renderQuickStock();
}

function fabMostrarAlertas(tipo) {
  const lista = _fabAlertas[tipo] || [];
  const esFalta = tipo === 'faltantes';
  const tf = document.getElementById('tabFalt'), tb = document.getElementById('tabBajo');
  if (tf && tb) {
    tf.classList.toggle('active', esFalta); tf.setAttribute('aria-selected', String(esFalta));
    tb.classList.toggle('active', !esFalta); tb.setAttribute('aria-selected', String(!esFalta));
  }
  const cont = document.getElementById('fabAlertas');
  if (!cont) return;
  if (!lista.length) {
    cont.innerHTML = emptyState(esFalta ? 'Sin faltantes: ningún insumo tiene stock negativo.' : 'Ningún insumo está en o bajo su mínimo.');
    return;
  }
  cont.innerHTML = `<div class="table-wrap table-scroll"><table>
    <thead><tr><th>Insumo</th><th>Talle</th><th class="num">Stock</th><th class="num">Mínimo</th><th>Estado</th><th class="hide-sm">Proveedor</th></tr></thead>
    <tbody>${lista.map(a => `
      <tr>
        <td>${escHtml(a.nombre)}</td>
        <td class="text-muted">${a.talle ? escHtml(a.talle) : '—'}</td>
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
        <input class="form-input" type="number" id="qsCantidad" value="1" min="1" />
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

  if (!insumo_id || !cantidad) { toast('Completar todos los campos', 'error'); return; }

  try {
    await API.movimientos.rapido({ insumo_id: Number(insumo_id), talle, cantidad, tipo });
    toast('Movimiento registrado', 'success');
    renderDashboard();
  } catch (e) {
    toast(e.message, 'error');
  }
}
