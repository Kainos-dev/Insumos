'use strict';

const express = require('express');
const router  = express.Router();
const svc     = require('../services/pedidosService');

router.get('/faltantes', (req, res) => {
  res.json(svc.detectarFaltantes());
});

// Todos los insumos con stock actual (para el formulario de nuevo pedido)
router.get('/insumos-stock', (req, res) => {
  res.json(svc.getInsumosConStock());
});

router.get('/', (req, res) => {
  res.json(svc.listarPedidos());
});

router.get('/:id', (req, res) => {
  const p = svc.getPedido(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  res.json(p);
});

router.post('/', (req, res) => {
  const { proveedor_id, lineas } = req.body;
  if (!proveedor_id || !lineas || !lineas.length) {
    return res.status(400).json({ error: 'proveedor_id y lineas son requeridos' });
  }
  const id = svc.crearPedido(Number(proveedor_id), lineas);
  res.json({ id });
});

// Errores de negocio (AppError) los responde el manejador central con su código
router.put('/:id/estado', (req, res) => {
  svc.actualizarEstado(Number(req.params.id), req.body.estado);
  res.json({ ok: true });
});

module.exports = router;
