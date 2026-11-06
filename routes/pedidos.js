'use strict';

const { crearRouter } = require('../utils/router');
const router = crearRouter();
const svc = require('../services/pedidosService');

router.get('/faltantes', async (req, res) => {
  res.json(await svc.detectarFaltantes());
});

// Todos los insumos con stock actual (para el formulario de nuevo pedido)
router.get('/insumos-stock', async (req, res) => {
  res.json(await svc.getInsumosConStock());
});

router.get('/', async (req, res) => {
  res.json(await svc.listarPedidos());
});

router.get('/:id', async (req, res) => {
  const p = await svc.getPedido(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  res.json(p);
});

router.post('/', async (req, res) => {
  const { proveedor_id, lineas } = req.body;
  if (!proveedor_id || !lineas || !lineas.length) {
    return res.status(400).json({ error: 'proveedor_id y lineas son requeridos' });
  }
  // responsable_id (opcional): el elegido en pantalla; el servidor lo valida contra los insumos
  const id = await svc.crearPedido(Number(proveedor_id), lineas,
    Object.prototype.hasOwnProperty.call(req.body, 'responsable_id') ? req.body.responsable_id : undefined);
  res.json({ id });
});

// Errores de negocio (AppError) los responde el manejador central con su código
router.put('/:id/estado', async (req, res) => {
  await svc.actualizarEstado(Number(req.params.id), req.body.estado);
  res.json({ ok: true });
});

module.exports = router;
