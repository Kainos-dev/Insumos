// ============================================================
// pages/asignaciones.js — Fábrica › Asignación de responsables
// Asigna o cambia el responsable de reposición de cada insumo.
// Asignar NO modifica stock, movimientos ni historiales.
// ============================================================

let _asig = { insumos: [], responsables: [], filtro: 'sin', seleccion: new Set() };

async function renderAsignaciones() {
  setPageTitle('Asignación de responsables');
  setTopbarActions(`<button class="btn btn-sm btn-ghost" onclick="router.go('fabrica')">← Volver a Fábrica</button>`);
  loading();

  const est = await API.responsables.estado();
  if (!est.disponible) {
    document.getElementById('pageBody').innerHTML = avisoMigracionPendiente();
    return;
  }
  const [insumos, lista] = await Promise.all([API.insumos.list(), API.responsables.list()]);
  _asig.insumos = insumos;
  _asig.responsables = lista.responsables.filter(r => r.activo);
  _asig.seleccion = new Set();
  dibujarAsignaciones();
}

function asigFiltrados() {
  const f = _asig.filtro;
  if (f === 'todos') return _asig.insumos;
  if (f === 'sin') return _asig.insumos.filter(i => !i.responsable);
  return _asig.insumos.filter(i => i.responsable && i.responsable.slug === f);
}

function asigOpciones(seleccionado) {
  return `<option value="">Sin asignar</option>` + _asig.responsables.map(r =>
    `<option value="${r.id}" ${seleccionado === r.id ? 'selected' : ''}>${escHtml(r.nombre)}</option>`).join('');
}

function dibujarAsignaciones() {
  const sinAsignar = _asig.insumos.filter(i => !i.responsable).length;
  const filtros = [
    { clave: 'sin', label: 'Sin asignar', n: sinAsignar },
    { clave: 'todos', label: 'Todos', n: _asig.insumos.length },
    ..._asig.responsables.map(r => ({ clave: r.slug, label: r.nombre,
      n: _asig.insumos.filter(i => i.responsable && i.responsable.slug === r.slug).length })),
  ];
  const filas = asigFiltrados();
  const todosMarcados = filas.length > 0 && filas.every(i => _asig.seleccion.has(i.id));

  document.getElementById('pageBody').innerHTML = `
    <div class="notice" role="status">
      <span class="notice-icon" aria-hidden="true">ℹ</span>
      <div>
        <strong>${sinAsignar ? `${sinAsignar} de ${_asig.insumos.length} insumos sin responsable.` : 'Todos los insumos tienen responsable.'}</strong>
        <p>Cada insumo tiene un único responsable de reposición. Asignar o cambiar responsables no modifica stock, movimientos ni historiales.
        No se puede cambiar el responsable de un insumo que está en pedidos abiertos de otro responsable.</p>
      </div>
    </div>

    <div class="card card--flush">
      <div class="card-head">
        <div class="segmented" role="tablist" aria-label="Filtrar insumos">
          ${filtros.map(f => `<button role="tab" aria-selected="${f.clave === _asig.filtro}" class="${f.clave === _asig.filtro ? 'active' : ''}"
             onclick="asigFiltrar('${f.clave}')">${escHtml(f.label)} <span class="tab-count">${f.n}</span></button>`).join('')}
        </div>
      </div>
      <div class="toolbar">
        <span class="toolbar-count">${_asig.seleccion.size ? `${_asig.seleccion.size} seleccionado(s)` : 'Seleccioná insumos para asignarlos en bloque'}</span>
        <label class="visually-hidden" for="asigBloque">Responsable para los seleccionados</label>
        <select class="form-select" id="asigBloque" ${_asig.seleccion.size ? '' : 'disabled'}>${asigOpciones(null)}</select>
        <button class="btn btn-sm btn-primary" onclick="asigAplicarBloque()" ${_asig.seleccion.size ? '' : 'disabled'}>Asignar seleccionados</button>
      </div>
      ${filas.length === 0
        ? emptyState(_asig.filtro === 'sin' ? 'No quedan insumos sin responsable.' : 'No hay insumos en este filtro.')
        : `<div class="table-wrap"><table>
          <thead><tr>
            <th style="width:32px"><input type="checkbox" aria-label="Seleccionar todos" ${todosMarcados ? 'checked' : ''} onchange="asigMarcarTodos(this.checked)"></th>
            <th>Insumo</th><th>Tipo</th><th class="hide-sm">Proveedor</th><th>Estado</th><th>Responsable</th>
          </tr></thead>
          <tbody>${filas.map(i => `
            <tr>
              <td><input type="checkbox" aria-label="Seleccionar ${escHtml(i.nombre)}" ${_asig.seleccion.has(i.id) ? 'checked' : ''} onchange="asigMarcar(${i.id}, this.checked)"></td>
              <td><strong>${escHtml(i.nombre)}</strong>${i.color ? ` <span class="text-muted">· ${escHtml(i.color)}</span>` : ''}</td>
              <td>${tipoBadge(i.tipo)}</td>
              <td class="text-muted hide-sm">${escHtml(i.proveedor_nombre || '—')}</td>
              <td>${estadoStockBadge(i.estado_stock)}</td>
              <td>
                <label class="visually-hidden" for="asigSel_${i.id}">Responsable de ${escHtml(i.nombre)}</label>
                <select class="form-select resp-select" id="asigSel_${i.id}" onchange="asigCambiar(${i.id}, this)">
                  ${asigOpciones(i.responsable ? i.responsable.id : null)}
                </select>
              </td>
            </tr>`).join('')}
          </tbody></table></div>`}
    </div>`;
}

function asigFiltrar(clave) { _asig.filtro = clave; _asig.seleccion = new Set(); dibujarAsignaciones(); }
function asigMarcar(id, on) { on ? _asig.seleccion.add(id) : _asig.seleccion.delete(id); dibujarAsignaciones(); }
function asigMarcarTodos(on) { for (const i of asigFiltrados()) on ? _asig.seleccion.add(i.id) : _asig.seleccion.delete(i.id); dibujarAsignaciones(); }

function asigActualizarLocal(insumoId, respId) {
  const ins = _asig.insumos.find(i => i.id === insumoId);
  const r = _asig.responsables.find(x => x.id === respId);
  if (ins) ins.responsable = r ? { id: r.id, slug: r.slug, nombre: r.nombre } : null;
  return ins;
}

async function asigCambiar(insumoId, sel) {
  const respId = sel.value ? Number(sel.value) : null;
  sel.disabled = true;
  try {
    await API.responsables.asignar(insumoId, respId);
    const ins = asigActualizarLocal(insumoId, respId);
    toast(respId ? `${ins.nombre}: asignado a ${ins.responsable.nombre}` : `${ins.nombre}: sin responsable`, 'success');
    dibujarAsignaciones();
  } catch (e) {
    toast(e.message, 'error');
    dibujarAsignaciones();   // el selector vuelve al responsable vigente
  }
}

async function asigAplicarBloque() {
  const valor = document.getElementById('asigBloque').value;
  const respId = valor ? Number(valor) : null;
  const ids = [..._asig.seleccion];
  if (!ids.length) return;
  const destino = respId ? _asig.responsables.find(r => r.id === respId).nombre : 'Sin asignar';
  if (!confirmAction(`¿Asignar ${ids.length} insumo(s) a ${destino}?\nNo se modifica stock ni movimientos.`)) return;
  try {
    await API.responsables.asignarVarios(ids.map(id => ({ insumo_id: id, responsable_id: respId })));
    ids.forEach(id => asigActualizarLocal(id, respId));
    _asig.seleccion = new Set();
    toast(`${ids.length} insumo(s) asignados a ${destino}`, 'success');
    dibujarAsignaciones();
  } catch (e) { toast(e.message, 'error'); }
}
