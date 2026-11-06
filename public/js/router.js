// ============================================================
// router.js — Router SPA por hash
//
// Rutas visibles:  #fabrica, #espacio/<slug>, #insumos, #proveedores,
//                  #productos, #planillas, #pedidos, #movimientos
// Alias antiguos:  #dashboard → Fábrica, #ordenes → Planillas de Corte
// ============================================================

const GRUPO_ESPACIOS = 'Espacios de trabajo';
const GRUPO_GESTION  = 'Gestión';

const PAGES = {
  fabrica:     { group: GRUPO_ESPACIOS, render: (id) => renderDashboard(id) },
  espacio:     { group: GRUPO_ESPACIOS, render: (id) => renderEspacio(id) },
  insumos:     { group: GRUPO_GESTION,  render: (id) => renderInsumos(id) },
  proveedores: { group: GRUPO_GESTION,  render: (id) => renderProveedores(id) },
  productos:   { group: GRUPO_GESTION,  render: (id) => renderProductos(id) },
  planillas:   { group: GRUPO_GESTION,  render: (id) => renderOrdenes(id) },
  pedidos:     { group: GRUPO_GESTION,  render: (id) => renderPedidos(id) },
  movimientos: { group: GRUPO_GESTION,  render: (id) => renderMovimientos(id) },
};

// Compatibilidad con enlaces o marcadores anteriores
const PAGE_ALIASES = { dashboard: 'fabrica', ordenes: 'planillas' };

const router = {
  current: null,

  go(page, id) {
    page = PAGE_ALIASES[page] || page;
    window.location.hash = id ? `${page}/${id}` : page;
  },

  parse(hash) {
    const clean = (hash || '').replace(/^#\/?/, '');
    const parts = clean.split('/');
    let page = parts[0] || 'fabrica';
    page = PAGE_ALIASES[page] || page;
    if (!PAGES[page]) page = 'fabrica';
    return { page, id: parts[1] || null };
  },

  async navigate() {
    const { page, id } = this.parse(window.location.hash);
    const p = PAGES[page];

    // Estado activo del menú (los espacios se distinguen por slug)
    document.querySelectorAll('.nav-item').forEach(el => {
      const match = el.dataset.page === page && (!el.dataset.slug || el.dataset.slug === id);
      el.classList.toggle('active', match);
      if (match) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });

    setBreadcrumb(p.group);
    this.current = page;
    closeSidebar();
    const scroller = document.getElementById('pageScroll');
    if (scroller) scroller.scrollTop = 0;

    try {
      await p.render(id);
    } catch (e) {
      console.error(e);
      document.getElementById('pageBody').innerHTML = `
        <div class="card">
          <div class="empty-state">
            <div class="empty-state-icon">⚠</div>
            <div class="empty-state-text text-red">${escHtml(e.message)}</div>
          </div>
        </div>`;
      toast('Error al cargar la página', 'error');
    }
  }
};

// ——— Menú lateral ———

function renderNavEspacios() {
  const cont = document.getElementById('navEspacios');
  if (!cont) return;
  cont.insertAdjacentHTML('beforeend', ESPACIOS.map(e => `
    <a href="#espacio/${e.slug}" class="nav-item" data-page="espacio" data-slug="${e.slug}" role="listitem">
      <span class="nav-avatar" style="--avatar:${e.color}" aria-hidden="true">${e.inicial}</span>
      <span class="nav-label">${escHtml(e.nombre)}</span>
    </a>`).join(''));
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('menuToggle').setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('menuToggle').setAttribute('aria-expanded', 'false');
}

renderNavEspacios();

// Al hacer clic en un ítem ya activo no cambia el hash: cerramos el menú igual
document.getElementById('sidebar').addEventListener('click', e => {
  if (e.target.closest('.nav-item')) closeSidebar();
});
document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });

window.addEventListener('hashchange', () => router.navigate());
window.addEventListener('DOMContentLoaded', () => router.navigate());
