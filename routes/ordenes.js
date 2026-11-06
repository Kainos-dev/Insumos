'use strict';

// Planillas de Corte (nombre interno: órdenes de producción).
// Los errores de negocio (AppError) los responde el manejador central
// con su código: 404 inexistente, 409 estado no permitido, 400 datos inválidos.
const { crearRouter } = require('../utils/router');
const router = crearRouter();
const svc = require('../services/ordenesService');
const { generarPDFOrden } = require('../utils/printService');
const { AppError } = require('../utils/errores');

router.get('/', async (req, res) => {
  res.json(await svc.listarOrdenes());
});

router.get('/:id', async (req, res) => {
  const o = await svc.getOrden(Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Planilla no encontrada' });
  res.json(o);
});

router.post('/', async (req, res) => {
  const id = await svc.crearOrden(req.body.descripcion);
  res.json({ id });
});

router.post('/:id/detalle', async (req, res) => {
  const { producto_id, talle, cantidad } = req.body;
  if (!producto_id || !talle || !cantidad) {
    throw new AppError('producto_id, talle y cantidad son requeridos');
  }
  await svc.agregarDetalle(Number(req.params.id), Number(producto_id), talle, cantidad);
  res.json({ ok: true });
});

// Agregar múltiples talles de un producto en una sola operación
// body: { producto_id, lineas: [{talle, cantidad}], numero_pedido? }
router.post('/:id/detalles-bulk', async (req, res) => {
  const { producto_id, lineas, numero_pedido } = req.body;
  if (!producto_id || !Array.isArray(lineas) || !lineas.length) {
    throw new AppError('producto_id y lineas[] son requeridos');
  }
  const validas = lineas.filter(l => l.talle && Number(l.cantidad) > 0);
  if (!validas.length) throw new AppError('Al menos una línea con cantidad > 0');
  await svc.agregarDetallesBulk(Number(req.params.id), Number(producto_id), validas, numero_pedido || null);
  res.json({ ok: true });
});

router.put('/detalle/:detalle_id', async (req, res) => {
  await svc.actualizarDetalle(Number(req.params.detalle_id), req.body.cantidad);
  res.json({ ok: true });
});

router.delete('/detalle/:detalle_id', async (req, res) => {
  await svc.eliminarDetalle(Number(req.params.detalle_id));
  res.json({ ok: true });
});

router.get('/:id/verificar', async (req, res) => {
  res.json(await svc.verificar(Number(req.params.id)));
});

router.post('/:id/confirmar', async (req, res) => {
  await svc.confirmarOrden(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/:id/cancelar', async (req, res) => {
  res.json({ ok: true, ...(await svc.cancelarOrden(Number(req.params.id))) });
});

router.get('/:id/pdf', async (req, res) => {
  await generarPDFOrden(Number(req.params.id), res);
});

module.exports = router;
