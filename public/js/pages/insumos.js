// ============================================================
// pages/insumos.js
// ============================================================

let _insumos = [];
let _proveedores = [];

async function renderInsumos(subId) {
  setPageTitle('Insumos');
  setTopbarActions(`
    <button class="btn btn-primary" onclick="modalCrearInsumo()">+ Nuevo Insumo</button>
  `);
  loading();

  [_insumos, _proveedores] = await Promise.all([API.insumos.list(), API.proveedores.list()]);

  const TIPOS = ['plantilla','fondo','cierre','hebilla'];
  const tipoFiltro = {};
  for (const t of TIPOS) tipoFiltro[t] = _insumos.filter(i => i.tipo === t);

  let html = `<div class="tabs" id="insumosTabs">
    ${TIPOS.map((t,i) => `<button class="tab-btn${i===0?' active':''}" onclick="switchInsumoTab('${t}',this)">${t.charAt(0).toUpperCase()+t.slice(1)}s (${tipoFiltro[t].length})</button>`).join('')}
  </div>`;

  for (const tipo of TIPOS) {
    html += `<div class="insumo-tab-panel" id="tab_${tipo}" style="${tipo!=='plantilla'?'display:none':''}">
      ${renderInsumosTable(tipoFiltro[tipo])}
    </div>`;
  }

  document.getElementById('pageBody').innerHTML = html;

  if (subId) {
    const ins = _insumos.find(i => i.id == subId);
    if (ins) { switchInsumoTab(ins.tipo); modalEditarInsumo(ins.id); }
  }
}

function switchInsumoTab(tipo, btn) {
  document.querySelectorAll('.insumo-tab-panel').forEach(p => p.style.display = 'none');
  document.querySelectorAll('#insumosTabs .tab-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById(`tab_${tipo}`);
  if (panel) panel.style.display = '';
  if (btn) btn.classList.add('active');
  else {
    const tabs = document.querySelectorAll('#insumosTabs .tab-btn');
    const TIPOS = ['plantilla','fondo','cierre','hebilla'];
    const idx = TIPOS.indexOf(tipo);
    if (tabs[idx]) tabs[idx].classList.add('active');
  }
}

function renderInsumosTable(insumos) {
  if (!insumos.length) return emptyState('Sin insumos en esta categoría');
  return `<div class="card"><div class="table-wrap"><table>
    <thead><tr>
      <th>Nombre</th><th>Color</th><th>Proveedor</th><th class="num">Stock mín.</th><th class="num">Stock total</th><th>Estado</th><th>Acciones</th>
    </tr></thead>
    <tbody>
      ${insumos.map(i => {
        const sc = stockColor(i.stock_total, i.stock_minimo);
        return `<tr>
          <td><strong>${escHtml(i.nombre)}</strong>
            ${i.stock_duplicados ? `<span class="badge badge-gold" title="Hay ${i.stock_duplicados} registros de stock duplicados de un error anterior. Se muestra el valor que usa el sistema; requiere conteo físico.">Conciliación pendiente</span>` : ''}</td>
          <td>${i.color ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${colorToCSS(i.color)};margin-right:6px;vertical-align:middle"></span>${escHtml(i.color)}` : '<span class="text-muted">—</span>'}</td>
          <td>${escHtml(i.proveedor_nombre || '—')}</td>
          <td class="num">${i.stock_minimo}</td>
          <td class="num"><span class="${sc} bold">${i.stock_total}</span></td>
          <td>${stockBadge(i.stock_total, i.stock_minimo)}</td>
          <td>
            <div class="flex-gap">
              <button class="btn btn-sm" onclick="modalEditarInsumo(${i.id})">Editar</button>
              <button class="btn btn-sm btn-danger" onclick="eliminarInsumo(${i.id})">Eliminar</button>
            </div>
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div></div>`;
}

function colorToCSS(c) {
  const map = { negro:'#222', blanco:'#eee', marrón:'#7a4a1a', dorado:'#d4a017', plateado:'#aaa', rojo:'#c00', azul:'#226' };
  return map[c] || '#888';
}

function buildInsumoForm(ins = null) {
  const tipo = ins?.tipo || 'plantilla';
  const conTalles = tipo === 'plantilla' || tipo === 'fondo';

  return `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Nombre *</label>
        <input class="form-input" id="fNombre" value="${escHtml(ins?.nombre || '')}" placeholder="Ej: Plantilla Standard" />
      </div>
      <div class="form-group">
        <label class="form-label">Tipo *</label>
        <select class="form-select" id="fTipo" onchange="onInsumoTipoChange(this.value, ${ins ? 'true' : 'false'})">
          ${['plantilla','fondo','cierre','hebilla'].map(t => `<option value="${t}" ${ins?.tipo===t?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Color</label>
        <input class="form-input" id="fColor" value="${escHtml(ins?.color || '')}" placeholder="negro, blanco, marrón..." />
      </div>
      <div class="form-group">
        <label class="form-label">Stock Mínimo</label>
        <input class="form-input" type="number" id="fStockMin" value="${ins?.stock_minimo ?? 0}" />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Proveedor</label>
      <select class="form-select" id="fProveedor">
        <option value="">— Sin proveedor —</option>
        ${_proveedores.map(p => `<option value="${p.id}" ${ins?.proveedor_id==p.id?'selected':''}>${escHtml(p.nombre)}</option>`).join('')}
      </select>
    </div>
    <hr class="divider" />
    ${conTalles ? `
      <div class="form-group">
        <label class="form-label">Talles disponibles</label>
        <div id="insumoTallesSelector">
          ${TALLES_CALZADO.map(talle => `
            <label style="display:inline-flex;gap:4px;margin:4px 8px 4px 0">
              <input type="checkbox" value="${talle}"
                ${(ins?.talles || []).includes(String(talle)) ? 'checked' : ''}>
              ${talle}
            </label>
          `).join('')}
        </div>
      </div>
      ` : ''}
    <div id="stockSection">
      ${conTalles ? renderStockTallesSection(ins?.stock_rows || []) : renderStockGeneralSection(ins?.stock_rows || [])}
    </div>
  `;
}

function renderStockTallesSection(stockRows) {
  return `
    <div class="form-group">
      <label class="form-label">Stock por Talle</label>
      ${buildStockTallesForm(stockRows)}
    </div>
  `;
}

function renderStockGeneralSection(stockRows) {
  const stock = stockRows[0]?.stock ?? 0;
  return `
    <div class="form-group">
      <label class="form-label">Stock General</label>
      <input class="form-input" type="number" id="fStockGeneral" value="${stock}" style="max-width:150px" />
    </div>
  `;
}

function onInsumoTipoChange(tipo, editing) {
  const section = document.getElementById('stockSection');
  if (!section) return;
  const conTalles = tipo === 'plantilla' || tipo === 'fondo';
  section.innerHTML = conTalles ? renderStockTallesSection([]) : renderStockGeneralSection([]);
}

function modalCrearInsumo() {
  Modal.open('Nuevo Insumo', buildInsumoForm(), {
    onOpen: body => {
      body.insertAdjacentHTML('beforeend', `
        <div class="modal-footer">
          <button class="btn" onclick="Modal.close()">Cancelar</button>
          <button class="btn btn-primary" onclick="guardarInsumo(null)">Crear</button>
        </div>`);
    }
  });
}

async function modalEditarInsumo(id) {
  const ins = await API.insumos.get(id);
  Modal.open(`Editar — ${ins.nombre}`, buildInsumoForm(ins), {
    onOpen: body => {
      body.insertAdjacentHTML('beforeend', `
        <div class="modal-footer">
          <button class="btn" onclick="Modal.close()">Cancelar</button>
          <button class="btn btn-primary" onclick="guardarInsumo(${id})">Guardar</button>
        </div>`);
    }
  });
}

async function guardarInsumo(id) {
  const nombre = document.getElementById('fNombre').value.trim();
  const tipo   = document.getElementById('fTipo').value;
  const color  = document.getElementById('fColor').value.trim() || null;
  const stock_minimo = parseInt(document.getElementById('fStockMin').value) || 0;
  const proveedor_id = document.getElementById('fProveedor').value || null;

  if (!nombre) {
    toast('El nombre es requerido', 'error');
    return;
  }

  const conTalles = tipo === 'plantilla' || tipo === 'fondo';

  let stock_rows;
  if (conTalles) {
    stock_rows = readStockTallesForm(document.getElementById('modalBody'));
  } else {
    const v = parseInt(document.getElementById('fStockGeneral').value) || 0;
    stock_rows = [{ talle: null, stock: v }];
  }

  const talles = conTalles
    ? [...document.querySelectorAll('#insumoTallesSelector input:checked')].map(c => c.value)
    : [];

  const data = {
    nombre,
    tipo,
    color,
    stock_minimo,
    proveedor_id: proveedor_id ? Number(proveedor_id) : null,
    talles,
    stock_rows
  };

  try {
    if (id) await API.insumos.update(id, data);
    else await API.insumos.create(data);

    toast(id ? 'Insumo actualizado' : 'Insumo creado', 'success');
    Modal.close();
    renderInsumos();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function eliminarInsumo(id) {
  if (!confirmAction('¿Eliminar este insumo? No se puede deshacer.')) return;
  try {
    await API.insumos.delete(id);
    toast('Insumo eliminado', 'success');
    renderInsumos();
  } catch (e) {
    toast(e.message, 'error');
  }
}
