// ============================================================
// ui.js — Shared UI utilities
// ============================================================

// ===== MODAL =====
const Modal = {
  open(title, html, opts = {}) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = html;
    document.getElementById('modalOverlay').classList.add('open');
    if (opts.onOpen) opts.onOpen(document.getElementById('modalBody'));
  },
  close() {
    document.getElementById('modalOverlay').classList.remove('open');
    document.getElementById('modalBody').innerHTML = '';
  },
  setTitle(t) { document.getElementById('modalTitle').textContent = t; }
};

document.getElementById('modalClose').addEventListener('click', Modal.close);
document.getElementById('modalOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modalOverlay')) Modal.close();
});

// ===== TOAST =====
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ===== CONFIRM =====
function confirmAction(msg) {
  return window.confirm(msg);
}

// ===== LOADING =====
function loading(html = '<em style="color:var(--text2)">Cargando...</em>') {
  document.getElementById('pageBody').innerHTML = `<div style="padding:40px;text-align:center">${html}</div>`;
}

// ===== HELPERS =====
function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

// Etiquetas visibles de los estados (los valores internos no cambian)
const ESTADO_LABELS = {
  borrador:   'Borrador',
  confirmada: 'Confirmada',
  cancelada:  'Cancelada',
  enviado:    'Enviado',
  recibido:   'Recibido',
  cancelado:  'Cancelado',
  faltante:   'Faltante',
  stock_bajo: 'Stock bajo',
  sin_stock:  'Sin stock',
};

function estadoBadge(estado) {
  const map = {
    borrador:   'badge-gray',
    confirmada: 'badge-green',
    cancelada:  'badge-red',
    enviado:    'badge-blue',
    recibido:   'badge-green',
    cancelado:  'badge-red',
    faltante:   'badge-red',
    stock_bajo: 'badge-gold',
  };
  const label = ESTADO_LABELS[estado] || estado;
  return `<span class="badge ${map[estado] || 'badge-gray'}">${escHtml(label)}</span>`;
}

// Estado de stock con color, forma y texto. Misma regla que el servidor:
// negativo → Faltante · cero → Sin stock · 0 < stock ≤ mínimo (mínimo > 0) → Stock bajo · resto → OK
const STOCK_ESTADOS = {
  faltante:   { clase: 'falta', label: 'Faltante' },
  sin_stock:  { clase: 'sin',   label: 'Sin stock' },
  stock_bajo: { clase: 'bajo',  label: 'Stock bajo' },
  ok:         { clase: 'ok',    label: 'OK' },
};

function clasificarStock(stock, minimo) {
  if (stock < 0) return 'faltante';
  if (stock === 0) return 'sin_stock';
  if (minimo > 0 && stock <= minimo) return 'stock_bajo';
  return 'ok';
}

function stockBadge(stock, minimo) {
  return estadoStockBadge(clasificarStock(stock, minimo));
}

// Estado ya calculado por el servidor ('faltante' | 'sin_stock' | 'stock_bajo' | 'ok')
function estadoStockBadge(estado) {
  const e = STOCK_ESTADOS[estado] || STOCK_ESTADOS.ok;
  return `<span class="stock-state stock-state--${e.clase}">${e.label}</span>`;
}

// Etiquetas visibles de los movimientos y sus referencias
const MOVIMIENTO_LABELS = {
  ingreso:        'Ingreso',
  egreso:         'Egreso',
  ajuste:         'Ajuste',
  consumo_orden:  'Consumo de planilla',
  ingreso_pedido: 'Ingreso de pedido',
};
const REFERENCIA_LABELS = {
  orden: 'Planilla',
  pedido: 'Pedido',
  anulacion_orden: 'Anulación de planilla',
  alta_insumo: 'Alta de insumo',
  conciliacion: 'Conciliación',
};

function tipoBadge(tipo) {
  const map = {
    plantilla: 'badge-blue',
    fondo:     'badge-gold',
    cierre:    'badge-gray',
    hebilla:   'badge-gray',
  };
  return `<span class="badge ${map[tipo] || 'badge-gray'}">${tipo}</span>`;
}

function stockColor(stock, minimo) {
  return { faltante: 'text-red', sin_stock: 'text-orange', stock_bajo: 'text-gold', ok: 'text-green' }[clasificarStock(stock, minimo)];
}

function emptyState(msg = 'Sin datos') {
  return `<div class="empty-state">
    <div class="empty-state-icon">◌</div>
    <div class="empty-state-text">${msg}</div>
  </div>`;
}

function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ===== TOPBAR =====
function setTopbarActions(html) {
  document.getElementById('topbarActions').innerHTML = html;
}
function setPageTitle(t) {
  document.getElementById('pageTitle').textContent = t;
  document.title = t + ' — Darc Cuir & Yatay';
}
function setBreadcrumb(t) {
  document.getElementById('breadcrumb').textContent = t || '';
}

// ===== MENU TOGGLE (celular / tablet) =====
document.getElementById('menuToggle').addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  const open = !sb.classList.contains('open');
  sb.classList.toggle('open', open);
  document.getElementById('menuToggle').setAttribute('aria-expanded', String(open));
});

// ===== TALLE CONSTANTS =====
const TALLES_CALZADO = ['35','36','37','38','39','40','41','42','43','44','45','46'];

// ===== STOCK TALLES FORM BUILDER =====
function buildStockTallesForm(stockRows = [], talles = TALLES_CALZADO) {
  const stockMap = {};
  for (const r of stockRows) stockMap[r.talle] = r.stock;
  return `<div class="stock-talles-grid">
    ${talles.map(t => `
      <div class="stock-talle-cell">
        <label>${t}</label>
        <input type="number" name="talle_${t}" value="${stockMap[t] ?? 0}" data-talle="${t}" />
      </div>
    `).join('')}
  </div>`;
}

function readStockTallesForm(container) {
  const inputs = container.querySelectorAll('[data-talle]');
  return Array.from(inputs).map(inp => ({
    talle: inp.dataset.talle,
    stock: parseInt(inp.value) || 0,
  }));
}
