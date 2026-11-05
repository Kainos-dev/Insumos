// ============================================================
// api.js — Centralized API client
// ============================================================

const API = {
  async _req(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  },

  get:    (url)       => API._req('GET',    url),
  post:   (url, body) => API._req('POST',   url, body),
  put:    (url, body) => API._req('PUT',    url, body),
  delete: (url)       => API._req('DELETE', url),

  // Dashboard
  dashboard: () => API.get('/api/dashboard'),

  // Proveedores
  proveedores: {
    list:   ()     => API.get('/api/proveedores'),
    get:    (id)   => API.get(`/api/proveedores/${id}`),
    create: (data) => API.post('/api/proveedores', data),
    update: (id, data) => API.put(`/api/proveedores/${id}`, data),
    delete: (id)   => API.delete(`/api/proveedores/${id}`),
  },

  // Insumos
  insumos: {
    list:   ()     => API.get('/api/insumos'),
    get:    (id)   => API.get(`/api/insumos/${id}`),
    create: (data) => API.post('/api/insumos', data),
    update: (id, data) => API.put(`/api/insumos/${id}`, data),
    delete: (id)   => API.delete(`/api/insumos/${id}`),
    ajuste: (id, data) => API.post(`/api/insumos/${id}/stock/ajuste`, data),
    setStock: (id, data) => API.put(`/api/insumos/${id}/stock`, data),
  },

  // Productos
  productos: {
    list:   ()     => API.get('/api/productos'),
    get:    (id)   => API.get(`/api/productos/${id}`),
    create: (data) => API.post('/api/productos', data),
    update: (id, data) => API.put(`/api/productos/${id}`, data),
    delete: (id)   => API.delete(`/api/productos/${id}`),
  },

  // Órdenes
  ordenes: {
    list:         ()       => API.get('/api/ordenes'),
    get:          (id)     => API.get(`/api/ordenes/${id}`),
    create:       (data)   => API.post('/api/ordenes', data),
    addDetalle:   (id, d)  => API.post(`/api/ordenes/${id}/detalle`, d),
    addDetallesBulk: (id, data) => API.post(`/api/ordenes/${id}/detalles-bulk`, data),
    updateDetalle:(id, d)  => API.put(`/api/ordenes/detalle/${id}`, d),
    deleteDetalle:(id)     => API.delete(`/api/ordenes/detalle/${id}`),
    verificar:    (id)     => API.get(`/api/ordenes/${id}/verificar`),
    confirmar:    (id)     => API.post(`/api/ordenes/${id}/confirmar`),
    cancelar:     (id)     => API.post(`/api/ordenes/${id}/cancelar`),
    pdfUrl:       (id)     => `/api/ordenes/${id}/pdf`,
  },

  // Pedidos
  pedidos: {
    faltantes:    ()           => API.get('/api/pedidos/faltantes'),
    insumosStock: ()           => API.get('/api/pedidos/insumos-stock'),
    list:         ()           => API.get('/api/pedidos'),
    get:          (id)         => API.get(`/api/pedidos/${id}`),
    create:       (data)       => API.post('/api/pedidos', data),
    estado:       (id, estado) => API.put(`/api/pedidos/${id}/estado`, { estado }),
  },

  // Responsables de reposición
  responsables: {
    estado:        ()                 => API.get('/api/responsables/estado'),
    list:          ()                 => API.get('/api/responsables'),
    panel:         (slug)             => API.get(`/api/responsables/${encodeURIComponent(slug)}/panel`),
    asignar:       (insumoId, respId) => API.put(`/api/insumos/${insumoId}/responsable`, { responsable_id: respId }),
    asignarVarios: (asignaciones)     => API.put('/api/responsables/asignaciones', { asignaciones }),
    diagnostico:   ()                 => API.get('/api/responsables/diagnostico-pedidos'),
  },

  // Movimientos
  movimientos: {
    list:   (params) => API.get('/api/movimientos?' + new URLSearchParams(params || {})),
    rapido: (data)   => API.post('/api/movimientos/rapido', data),
  },
};
