// ============================================================
// pages/espacio.js — Espacio individual de un responsable
//
// Prototipo visual (E2): todavía no existen asignaciones de insumos,
// por lo que el panel muestra estados vacíos reales. La sección
// "Vista de demostración" usa datos ficticios claramente rotulados
// y NO consulta ni modifica la base de datos.
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

  const vacio = (texto) => `<div class="empty-state" style="padding:32px 16px">
      <div class="empty-state-icon">◌</div>
      <div class="empty-state-text">${texto}</div>
    </div>`;

  const demoRows = DEMO_INSUMOS.map(d => `
    <tr>
      <td><span class="demo-name">${d.nombre}</span></td>
      <td>${tipoBadge(d.tipo)}</td>
      <td>${d.talle ? 'T' + d.talle : '—'}</td>
      <td class="num">${d.stock}</td>
      <td class="num">${d.minimo}</td>
      <td>${stockBadge(d.stock, d.minimo)}</td>
    </tr>`).join('');

  document.getElementById('pageBody').innerHTML = `
    <div class="page-header">
      <div class="page-header-avatar" style="--avatar:${esp.color}" aria-hidden="true">${esp.inicial}</div>
      <div>
        <h2>${escHtml(esp.nombre)}</h2>
        <p>Responsable de reposición</p>
      </div>
    </div>

    <div class="notice" role="status">
      <span class="notice-icon" aria-hidden="true">ℹ</span>
      <div>
        <strong>Todavía no hay insumos asignados a ${escHtml(esp.nombre)}.</strong>
        <p>Cuando se habilite la asignación de responsables, este panel mostrará sus insumos,
        los faltantes a reponer y sus pedidos con datos reales.</p>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num">0</div><div class="stat-label">Insumos asignados</div></div>
      <div class="stat-card stat-card--red"><div class="stat-num">—</div><div class="stat-label">Faltantes</div></div>
      <div class="stat-card stat-card--gold"><div class="stat-num">—</div><div class="stat-label">Stock bajo</div></div>
      <div class="stat-card"><div class="stat-num">—</div><div class="stat-label">Pedidos pendientes</div></div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-title">Para reponer</div>
        ${vacio('Sin insumos asignados: no hay faltantes ni stock bajo para mostrar.')}
      </div>
      <div class="card">
        <div class="card-title">Mis pedidos</div>
        ${vacio('Los pedidos de ' + escHtml(esp.nombre) + ' aparecerán acá.')}
      </div>
    </div>

    <div class="card demo-card" aria-label="Vista de demostración con datos ficticios">
      <div class="demo-ribbon">◆ Demostración · datos ficticios</div>
      <div class="card-title">Así se verá “Mis insumos”</div>
      <p class="card-subtitle" style="margin-top:0">
        Ejemplo ilustrativo del diseño. Estos insumos y cantidades no existen en el sistema.
      </p>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Insumo</th><th>Tipo</th><th>Talle</th>
            <th class="num">Stock</th><th class="num">Mínimo</th><th>Estado</th>
          </tr></thead>
          <tbody>${demoRows}</tbody>
        </table>
      </div>
    </div>
  `;
}
