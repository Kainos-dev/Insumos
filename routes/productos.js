'use strict';

const { crearRouter, idDe } = require('../utils/router');
const router = crearRouter();
const { all, get, run, insert, transaction } = require('../db/database');

/** Talles y accesorios de varios productos, con dos consultas en total. */
async function completarProductos(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const [talles, accesorios] = await Promise.all([
    all('SELECT producto_id, talle FROM producto_talles WHERE producto_id = ANY(?::int[]) ORDER BY talle', [ids]),
    all(`
      SELECT pa.*, i.nombre AS insumo_nombre, i.tipo
      FROM producto_accesorios pa
      JOIN insumos i ON i.id=pa.insumo_id
      WHERE pa.producto_id = ANY(?::int[])
      ORDER BY pa.id
    `, [ids]),
  ]);
  for (const row of rows) {
    row.talles = talles.filter(t => t.producto_id === row.id).map(t => t.talle);
    row.accesorios = accesorios.filter(a => a.producto_id === row.id);
  }
  return rows;
}

/** Guarda talles y accesorios del producto (sin duplicados; el último accesorio repetido manda). */
async function guardarComposicion(productoId, talles, accesorios) {
  if (Array.isArray(talles) && talles.length) {
    await run(`INSERT INTO producto_talles (producto_id, talle)
               SELECT ?::int, t FROM unnest(?::text[]) AS t
               ON CONFLICT DO NOTHING`, [productoId, talles.map(t => (t === null || t === undefined ? t : String(t)))]);
  }
  if (Array.isArray(accesorios) && accesorios.length) {
    const ultimo = new Map(accesorios.map(a => [Number(a.insumo_id), a]));
    await run(`INSERT INTO producto_accesorios (producto_id, insumo_id, cantidad_por_par)
               SELECT ?::int, a.insumo_id, a.cantidad FROM unnest(?::int[], ?::int[]) AS a(insumo_id, cantidad)`,
    [productoId, [...ultimo.keys()], [...ultimo.values()].map(a => a.cantidad_por_par || 1)]);
  }
}

router.get('/', async (req, res) => {
  const rows = await all(`
    SELECT p.*, i1.nombre AS plantilla_nombre, i2.nombre AS fondo_nombre
    FROM productos p
    JOIN insumos i1 ON i1.id=p.plantilla_id
    JOIN insumos i2 ON i2.id=p.fondo_id
    ORDER BY p.nombre
  `);
  res.json(await completarProductos(rows));
});

router.get('/:id', async (req, res) => {
  const row = await get(`
    SELECT p.*, i1.nombre AS plantilla_nombre, i2.nombre AS fondo_nombre
    FROM productos p
    JOIN insumos i1 ON i1.id=p.plantilla_id
    JOIN insumos i2 ON i2.id=p.fondo_id
    WHERE p.id=?
  `, [idDe(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'No encontrado' });
  res.json((await completarProductos([row]))[0]);
});

router.post('/', async (req, res) => {
  const { nombre, plantilla_id, fondo_id, talles, accesorios } = req.body;
  if (!nombre || !plantilla_id || !fondo_id) {
    return res.status(400).json({ error: 'nombre, plantilla_id y fondo_id son requeridos' });
  }
  const newId = await transaction(async () => {
    const id = await insert(
      'INSERT INTO productos (nombre, plantilla_id, fondo_id) VALUES (?,?,?)',
      [nombre, plantilla_id, fondo_id]
    );
    await guardarComposicion(id, talles, accesorios);
    return id;
  });
  res.json({ id: newId });
});

router.put('/:id', async (req, res) => {
  const { nombre, plantilla_id, fondo_id, talles, accesorios } = req.body;
  const id = idDe(req.params.id);
  await transaction(async () => {
    await run('UPDATE productos SET nombre=?, plantilla_id=?, fondo_id=? WHERE id=?',
      [nombre, plantilla_id, fondo_id, id]);
    await run('DELETE FROM producto_talles WHERE producto_id=?', [id]);
    await run('DELETE FROM producto_accesorios WHERE producto_id=?', [id]);
    await guardarComposicion(id, talles, accesorios);
  });
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await run('DELETE FROM productos WHERE id=?', [idDe(req.params.id)]);
  res.json({ ok: true });
});

module.exports = router;
