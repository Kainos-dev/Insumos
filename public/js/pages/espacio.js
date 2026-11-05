// ============================================================
// pages/espacio.js — Espacio individual de un responsable
//
// Todavía no existen asignaciones de insumos, por lo que el panel
// muestra estados vacíos reales. La "Vista de demostración" usa datos
// ficticios rotulados como tales y NO consulta ni modifica la base.
// ============================================================

// Datos ficticios solo para ilustrar el diseño. No representan stock real.
const DEMO_INSUMOS = [
  { nombre: 'Insumo de ejemplo A', tipo: 'plantilla', talle: '38', stock: -4, minimo: 10 },
  { nombre: 'Insumo de ejemplo B', tipo: 'cierre',    talle: null, stock: 6,  minimo: 20 },
  { nombre: 'Insumo de ejemplo C', tipo: 'fondo',     talle: '41', stock: 35, minimo: 15 },
];

async function renderEspacio(slug) {
  const esp = getEspacio(slug);
  if (!esp) {
    setPageTitle('Espacio no encontrado');
    setTopbarActions('');
    document.getElementById('pageBody').innerHTML =
      `<div class="card">${emptyState('Este espacio de trabajo no existe.')}</div>`;
    return;
  }

  setPageTitle(esp.nombre);
  setTopbarActions('');

  const kpi = (label, value, hint = '') => `
    <div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div>
      ${hint ? `<div class="kpi-hint">${hint}</div>` : ''}
    </div>`;

  const demoRows = DEMO_INSUMOS.map(d => `
    <tr>
      <td><span class="demo-name">${d.nombre}</span></td>
      <td>${tipoBadge(d.tipo)}</td>
      <td class="text-muted">${d.talle || '—'}</td>
      <td class="num">${d.stock}</td>
      <td class="num text-muted">${d.minimo}</td>
      <td>${stockBadge(d.stock, d.minimo)}</td>
    </tr>`).join('');

  document.getElementById('pageBody').innerHTML = `
    <div class="identity">
      <span class="nav-avatar" style="--avatar:${esp.color}" aria-hidden="true">${esp.inicial}</span>
      Responsable de reposición
    </div>

    <div class="notice" role="status">
      <span class="notice-icon" aria-hidden="true">ℹ</span>
      <div>
        <strong>Todavía no hay insumos asignados a ${escHtml(esp.nombre)}.</strong>
        <p>Cuando se habilite la asignación de responsables, este espacio mostrará sus insumos, faltantes y pedidos reales.</p>
      </div>
    </div>

    <div class="kpi-strip">
      ${kpi('Faltantes', '—', 'sin asignaciones')}
      ${kpi('Stock bajo', '—', 'sin asignaciones')}
      ${kpi('Pedidos pendientes', '—', 'sin asignaciones')}
      ${kpi('Insumos asignados', 0)}
    </div>

    <div class="grid-main">
      <div class="card card--flush">
        <div class="card-head"><div class="card-title">Para reponer</div></div>
        ${emptyState('Sin insumos asignados: no hay faltantes ni stock bajo para mostrar.')}
      </div>
      <div class="card card--flush">
        <div class="card-head"><div class="card-title">Mis pedidos</div></div>
        ${emptyState('Los pedidos de ' + escHtml(esp.nombre) + ' aparecerán acá.')}
      </div>
    </div>

    <div class="card card--flush demo-card" style="margin-top:var(--gap)" aria-label="Vista de demostración con datos ficticios">
      <div class="card-head">
        <div class="card-title">Mis insumos <span class="text-muted" style="font-weight:400">· vista previa del diseño</span></div>
        <span class="demo-ribbon">◆ Demostración · datos ficticios</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Insumo</th><th>Tipo</th><th>Talle</th>
            <th class="num">Stock</th><th class="num">Mínimo</th><th>Estado</th>
          </tr></thead>
          <tbody>${demoRows}</tbody>
        </table>
      </div>
      <div class="kpi-hint" style="padding:8px var(--pad);border-top:1px solid var(--border)">
        Estos insumos y cantidades no existen en el sistema; solo ilustran cómo se verá el panel.
      </div>
    </div>
  `;
}
