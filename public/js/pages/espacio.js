// ============================================================
// pages/espacio.js — Espacio de trabajo de un responsable
//
// Muestra solo los insumos asignados al responsable, sus alertas y sus
// pedidos, con datos reales de la base. Es una vista de trabajo: no es un
// control de acceso (todavía no hay usuarios ni permisos).
// ============================================================

async function renderEspacio(slug) {
  const conf = getEspacio(slug) || {};
  setPageTitle(conf.nombre || 'Espacio');
  setTopbarActions('');
  loading();

  const est = await API.responsables.estado();
  if (!est.disponible) {
    document.getElementById('pageBody').innerHTML = avisoMigracionPendiente(
      'Cuando se aplique, este espacio mostrará los insumos asignados y sus pedidos.');
    return;
  }

  let data;
  try {
    data = await API.responsables.panel(slug);
  } catch (e) {
    setPageTitle('Espacio no encontrado');
    document.getElementById('pageBody').innerHTML = `<div class="card">${emptyState(escHtml(e.message))}</div>`;
    return;
  }

  const { responsable: r, insumos, alertas, pedidos, resumen } = data;
  setPageTitle(r.nombre);
  setTopbarActions(`<button class="btn btn-sm btn-ghost" onclick="renderEspacio('${escHtml(r.slug)}')">↻ Actualizar</button>`);

  const kpi = (label, value, cls = '') => `
    <div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value ${value ? cls : ''}">${value}</div></div>`;

  const alertasHtml = alertas.length === 0
    ? emptyState(insumos.length ? 'Nada para reponer: sus insumos no tienen faltantes, sin stock ni stock bajo.' : 'Sin insumos asignados.')
    : `<div class="table-wrap table-scroll"><table>
        <thead><tr><th>Insumo</th><th>Talle</th><th class="num">Stock</th><th class="num">Mínimo</th><th>Estado</th></tr></thead>
        <tbody>${alertas.map(a => `
          <tr>
            <td>${escHtml(a.nombre)}${a.conciliacion_pendiente ? ' <span class="badge badge-gold">Conciliar</span>' : ''}</td>
            <td class="text-muted nowrap">${a.talle ? escHtml(a.talle) : '—'}${a.talle && !a.talle_habilitado ? ' <span class="badge badge-gray">no habilitado</span>' : ''}</td>
            <td class="num ${a.stock < 0 ? 'text-red' : ''}">${a.stock}</td>
            <td class="num text-muted">${a.stock_minimo}</td>
            <td>${estadoStockBadge(a.tipo_alerta)}</td>
          </tr>`).join('')}
        </tbody></table></div>`;

  const pedidosHtml = pedidos.length === 0
    ? emptyState('Todavía no hay pedidos de ' + escHtml(r.nombre) + '.')
    : `<div class="table-wrap table-scroll"><table>
        <thead><tr><th>N.º</th><th>Proveedor</th><th>Estado</th><th class="num">Unid.</th><th>Fecha</th></tr></thead>
        <tbody>${pedidos.map(p => `
          <tr style="cursor:pointer" onclick="router.go('pedidos','${p.id}')">
            <td class="text-muted">#${p.id}</td>
            <td>${escHtml(p.proveedor_nombre)}</td>
            <td>${estadoBadge(p.estado)}</td>
            <td class="num">${p.total_unidades || 0}</td>
            <td class="text-muted nowrap">${formatDate(p.created_at)}</td>
          </tr>`).join('')}
        </tbody></table></div>`;

  const insumosHtml = insumos.length === 0
    ? `<div style="padding:4px var(--pad) var(--pad)">${emptyState('Todavía no hay insumos asignados a ' + escHtml(r.nombre) + '.')}
        <div class="text-center"><button class="btn btn-sm" onclick="router.go('fabrica','asignaciones')">Asignar desde Fábrica</button></div></div>`
    : `<div class="table-wrap"><table>
        <thead><tr><th>Insumo</th><th>Tipo</th><th class="hide-sm">Proveedor</th><th class="num">Stock total</th><th class="num">Mínimo</th><th>Estado</th></tr></thead>
        <tbody>${insumos.map(i => `
          <tr>
            <td><strong>${escHtml(i.nombre)}</strong>
              ${i.stock_duplicados ? ' <span class="badge badge-gold" title="Stock duplicado pendiente de conciliación">Conciliación pendiente</span>' : ''}
              ${i.sin_talles_habilitados ? ' <span class="badge badge-gray" title="Sin talles habilitados">Sin talles</span>' : ''}</td>
            <td>${tipoBadge(i.tipo)}</td>
            <td class="text-muted hide-sm">${escHtml(i.proveedor_nombre || '—')}</td>
            <td class="num ${stockColor(i.stock_total, i.stock_minimo)}">${i.stock_total}</td>
            <td class="num text-muted">${i.stock_minimo}</td>
            <td>${estadoStockBadge(i.estado_stock)}</td>
          </tr>`).join('')}
        </tbody></table></div>`;

  document.getElementById('pageBody').innerHTML = `
    <div class="identity">
      <span class="nav-avatar" style="--avatar:${conf.color || 'var(--text3)'}" aria-hidden="true">${escHtml(conf.inicial || r.nombre[0])}</span>
      Responsable de reposición
      <span class="text-muted" style="font-size:var(--fs-xs)">· vista de trabajo, no es un control de acceso</span>
    </div>

    <div class="kpi-strip">
      ${kpi('Faltantes', resumen.faltantes, 'text-red')}
      ${kpi('Sin stock', resumen.sin_stock, 'text-orange')}
      ${kpi('Stock bajo', resumen.stock_bajo, 'text-gold')}
      ${kpi('Pedidos pendientes', resumen.pedidos_pendientes)}
      ${kpi('Insumos asignados', resumen.insumos_asignados)}
    </div>

    <div class="grid-main">
      <div class="card card--flush">
        <div class="card-head"><div class="card-title">Para reponer</div><span class="tab-count">${alertas.length}</span></div>
        ${alertasHtml}
      </div>
      <div class="card card--flush">
        <div class="card-head"><div class="card-title">Mis pedidos</div>
          <button class="btn btn-sm btn-ghost" onclick="router.go('pedidos')">Pedidos →</button></div>
        ${pedidosHtml}
      </div>
    </div>

    <div class="card card--flush" style="margin-top:var(--gap)">
      <div class="card-head"><div class="card-title">Mis insumos</div><span class="tab-count">${insumos.length}</span></div>
      ${insumosHtml}
    </div>
  `;
}
