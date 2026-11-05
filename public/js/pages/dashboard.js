// ============================================================
// pages/dashboard.js — Espacio "Fábrica" (vista general)
// Usa únicamente los datos existentes de /api/dashboard.
// ============================================================

async function renderDashboard() {
  setPageTitle('Fábrica');
  setTopbarActions(`<button class="btn" onclick="renderDashboard()">↻ Actualizar</button>`);
  loading();

  const data = await API.dashboard();

  const { totales, stock_bajo, faltantes, ordenes_recientes, pedidos_pendientes } = data;

  const alertRow = (a, tipo) => `
    <div class="alert-row">
      <div style="flex:1;min-width:0">
        <strong>${escHtml(a.nombre)}</strong>
        ${a.talle ? `<span class="text-muted"> · Talle ${escHtml(a.talle)}</span>` : ''}
        ${tipo === 'falta' ? `<div class="text-muted text-small">Proveedor: ${escHtml(a.proveedor_nombre || '—')}</div>` : ''}
      </div>
      <span class="bold ${tipo === 'falta' ? 'text-red' : 'text-gold'}" style="font-variant-numeric:tabular-nums">
        ${tipo === 'falta' ? a.stock : `${a.stock} / ${a.stock_minimo}`}
      </span>
      ${stockBadge(a.stock, a.stock_minimo)}
    </div>`;

  const html = `
    <div class="page-header">
      <div class="page-header-avatar page-header-avatar--factory" aria-hidden="true">▦</div>
      <div>
        <h2>Fábrica</h2>
        <p>Vista general de insumos, planillas de corte y pedidos.</p>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card stat-card--accent">
        <div class="stat-num">${totales.insumos}</div>
        <div class="stat-label">Insumos</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${totales.productos}</div>
        <div class="stat-label">Productos</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${totales.proveedores}</div>
        <div class="stat-label">Proveedores</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${totales.ordenes_borrador}</div>
        <div class="stat-label">Planillas en borrador</div>
      </div>
      <div class="stat-card stat-card--gold">
        <div class="stat-num text-gold">${stock_bajo.length}</div>
        <div class="stat-label">Alertas de stock bajo</div>
      </div>
      <div class="stat-card stat-card--red">
        <div class="stat-num text-red">${faltantes.length}</div>
        <div class="stat-label">Faltantes (stock negativo)</div>
      </div>
    </div>

    <div class="card">
      <div class="section-header">
        <div class="card-title">Responsables de reposición</div>
        <span class="badge badge-gray">${totales.insumos} insumos sin responsable</span>
      </div>
      <p class="card-subtitle" style="margin-top:0">
        La asignación de insumos a cada responsable todavía no está habilitada.
      </p>
      <div class="resp-grid">
        ${ESPACIOS.map(e => `
          <a class="resp-card" href="#espacio/${e.slug}">
            <div class="resp-card-head">
              <span class="nav-avatar" style="--avatar:${e.color};width:36px;height:36px;font-size:15px" aria-hidden="true">${e.inicial}</span>
              <div>
                <div class="resp-card-name">${escHtml(e.nombre)}</div>
                <div class="resp-card-meta">Sin insumos asignados todavía</div>
              </div>
            </div>
            <span class="resp-card-link">Ver espacio →</span>
          </a>`).join('')}
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="section-header">
          <div class="card-title">Faltantes</div>
          <span class="badge badge-red">${faltantes.length}</span>
        </div>
        ${faltantes.length === 0
          ? emptyState('Sin faltantes')
          : `<div class="alert-list">${faltantes.map(a => alertRow(a, 'falta')).join('')}</div>`}
      </div>

      <div class="card">
        <div class="section-header">
          <div class="card-title">Stock bajo</div>
          <span class="badge badge-gold">${stock_bajo.length}</span>
        </div>
        ${stock_bajo.length === 0
          ? emptyState('Todo en orden')
          : `<div class="alert-list">${stock_bajo.map(a => alertRow(a, 'bajo')).join('')}</div>`}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Movimiento rápido de stock</div>
      <div class="quick-stock-panel" id="quickStockPanel">
        Cargando insumos...
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="section-header">
          <div class="card-title">Planillas de corte recientes</div>
          <button class="btn btn-sm" onclick="router.go('planillas')">Ver todas</button>
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
                  <td class="text-muted">${formatDate(o.created_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table></div>`
        }
      </div>

      <div class="card">
        <div class="section-header">
          <div class="card-title">Pedidos pendientes</div>
          <button class="btn btn-sm" onclick="router.go('pedidos')">Ver todos</button>
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
                  <td class="text-muted">${formatDate(p.created_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table></div>`
        }
      </div>
    </div>
  `;

  document.getElementById('pageBody').innerHTML = html;
  await renderQuickStock();
}

async function renderQuickStock() {
  const panel = document.getElementById('quickStockPanel');
  if (!panel) return;
  const insumos = await API.insumos.list();

  panel.innerHTML = `
    <div class="quick-stock-controls">
      <div class="form-group" style="flex:2 1 220px">
        <label class="form-label" for="qsInsumo">Insumo</label>
        <select class="form-select" id="qsInsumo" onchange="onQsInsumoChange()">
          <option value="">— Seleccionar —</option>
          ${insumos.map(i => `<option value="${i.id}" data-tipo="${i.tipo}">${escHtml(i.nombre)}</option>`).join('')}
        </select>
      </div>
      <div id="qsTalleWrap" style="display:none">
        <label class="form-label" for="qsTalle">Talle</label>
        <select class="form-select" id="qsTalle">
          ${TALLES_CALZADO.map(t => `<option value="${t}">${t}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="form-label" for="qsCantidad">Cantidad</label>
        <input class="form-input" type="number" id="qsCantidad" value="1" min="1" />
      </div>
      <div>
        <label class="form-label" for="qsTipo">Tipo de movimiento</label>
        <select class="form-select" id="qsTipo">
          <option value="ingreso">Ingreso</option>
          <option value="egreso">Egreso</option>
          <option value="ajuste">Ajuste</option>
        </select>
      </div>
      <div style="flex:0 0 auto">
        <button class="btn btn-primary" style="min-height:44px" onclick="doQuickStock()">Registrar movimiento</button>
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
