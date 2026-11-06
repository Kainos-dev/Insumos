'use strict';

const { crearRouter, idDe } = require('../utils/router');
const router = crearRouter();
const { all, get, run, insert } = require('../db/database');

router.get('/', async (req, res) => {
  const rows = await all(`
    SELECT p.*, COUNT(i.id) AS total_insumos
    FROM proveedores p
    LEFT JOIN insumos i ON i.proveedor_id = p.id
    GROUP BY p.id
    ORDER BY p.nombre
  `);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const row = await get('SELECT * FROM proveedores WHERE id=?', [idDe(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'No encontrado' });
  row.insumos = await all('SELECT * FROM insumos WHERE proveedor_id=? ORDER BY id', [row.id]);
  res.json(row);
});

router.post('/', async (req, res) => {
  const { nombre, contacto } = req.body;
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });
  const id = await insert('INSERT INTO proveedores (nombre, contacto) VALUES (?,?)', [nombre, contacto || null]);
  res.json({ id });
});

router.put('/:id', async (req, res) => {
  const { nombre, contacto } = req.body;
  await run('UPDATE proveedores SET nombre=?, contacto=? WHERE id=?', [nombre, contacto || null, idDe(req.params.id)]);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await run('DELETE FROM proveedores WHERE id=?', [idDe(req.params.id)]);
  res.json({ ok: true });
});

module.exports = router;
