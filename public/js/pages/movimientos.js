// ============================================================
// pages/movimientos.js
// ============================================================

async function renderMovimientos() {
  setPageTitle('Movimientos de Stock');
  setTopbarActions('');
  loading();

  const [movs, insumos] = await Promise.all([
    API.movimientos.list({ limit: 100 }),
    API.insumos.list()
  ]);

  const html = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-title">Filtrar por Insumo</div>
      <div style="display:flex;gap:8px;align-items:center">
        <select class="form-select" id="movFiltroInsumo" style="max-width:280px" onchange="filtrarMovimientos()">
          <option value="">— Todos los insumos —</option>
          ${insumos.map(i => `<option value="${i.id}">${escHtml(i.nombre)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" onclick="filtrarMovimientos()">Filtrar</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Últimos 100 Movimientos</div>
      <div class="table-wrap" id="movsTable">
        ${renderMovsTable(movs)}
      </div>
    </div>
  `;

  document.getElementById('pageBody').innerHTML = html;
}

function renderMovsTable(movs) {
  if (!movs.length) return emptyState('Sin movimientos');
  return `<table>
    <thead><tr>
      <th>Fecha</th><th>Insumo</th><th>Talle</th><th>Tipo</th><th class="num">Cantidad</th><th>Referencia</th>
    </tr></thead>
    <tbody>
      ${movs.map(m => {
        const esPos = m.cantidad > 0;
        const tipoBadgeMap = {
          ingreso:       'badge-green',
          egreso:        'badge-red',
          ajuste:        'badge-blue',
          consumo_orden: 'badge-gold',
          ingreso_pedido:'badge-green',
        };
        return `<tr>
          <td class="text-muted" style="white-space:nowrap">${formatDateTime(m.created_at)}</td>
          <td><strong>${escHtml(m.insumo_nombre)}</strong></td>
          <td>${escHtml(m.talle) || '—'}</td>
          <td><span class="badge ${tipoBadgeMap[m.tipo] || 'badge-gray'}">${escHtml(MOVIMIENTO_LABELS[m.tipo] || m.tipo)}</span></td>
          <td class="num ${esPos ? 'text-green' : 'text-red'} bold">${esPos ? '+' : ''}${m.cantidad}</td>
          <td class="text-muted">${m.referencia_tipo ? `${escHtml(REFERENCIA_LABELS[m.referencia_tipo] || m.referencia_tipo)}${m.referencia_id != null ? ' #' + m.referencia_id : ''}` : '—'}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

async function filtrarMovimientos() {
  const insumo_id = document.getElementById('movFiltroInsumo').value;
  const params = { limit: 100 };
  if (insumo_id) params.insumo_id = insumo_id;
  const movs = await API.movimientos.list(params);
  document.getElementById('movsTable').innerHTML = renderMovsTable(movs);
}
