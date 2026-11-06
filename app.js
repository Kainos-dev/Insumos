'use strict';

// Aplicación Express sin iniciar el servidor (permite probarla de forma aislada).
const express = require('express');
const path = require('path');
const { manejadorErrores } = require('./utils/errores');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/proveedores', require('./routes/proveedores'));
app.use('/api/insumos',     require('./routes/insumos'));
app.use('/api/productos',   require('./routes/productos'));
app.use('/api/ordenes',     require('./routes/ordenes'));
app.use('/api/pedidos',     require('./routes/pedidos'));
app.use('/api/dashboard',   require('./routes/dashboard'));
app.use('/api/movimientos', require('./routes/movimientos'));
app.use('/api/responsables', require('./routes/responsables'));

// Rutas de API inexistentes: JSON en vez de la página principal
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(manejadorErrores);

module.exports = app;
