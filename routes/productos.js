const express = require('express');
const router = express.Router();
const db = require('../db/init');

router.get('/', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM productos ORDER BY nombre');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/alertas/stock', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM productos WHERE stock <= stock_minimo ORDER BY stock ASC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/barcode/:codigo', async (req, res) => {
  try {
    const p = await db.get('SELECT * FROM productos WHERE codigo_barras = ?', [req.params.codigo]);
    if (!p) return res.status(404).json({ error: 'No encontrado' });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const p = await db.get('SELECT * FROM productos WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'No encontrado' });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { nombre, categoria, precio_compra, precio_venta, stock, stock_minimo, codigo_barras, unidad } = req.body;
    if (!nombre || precio_venta === undefined) return res.status(400).json({ error: 'Campos requeridos: nombre, precio_venta' });
    const r = await db.run(
      `INSERT INTO productos (nombre, categoria, precio_compra, precio_venta, stock, stock_minimo, codigo_barras, unidad)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [nombre, categoria || null, precio_compra || 0, precio_venta, stock || 0, stock_minimo || 5, codigo_barras || null, unidad || 'unidades']
    );
    res.json({ id: r.lastID, mensaje: 'Producto creado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { nombre, categoria, precio_compra, precio_venta, stock, stock_minimo, codigo_barras, unidad } = req.body;
    await db.run(
      `UPDATE productos SET nombre=?, categoria=?, precio_compra=?, precio_venta=?, stock=?, stock_minimo=?, codigo_barras=?, unidad=? WHERE id=?`,
      [nombre, categoria || null, precio_compra || 0, precio_venta, stock, stock_minimo || 5, codigo_barras || null, unidad || 'unidades', req.params.id]
    );
    res.json({ mensaje: 'Producto actualizado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM productos WHERE id = ?', [req.params.id]);
    res.json({ mensaje: 'Producto eliminado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/entrada', async (req, res) => {
  try {
    const { cantidad, precio_compra, nota } = req.body;
    if (!cantidad || cantidad <= 0) return res.status(400).json({ error: 'Cantidad invalida' });
    const producto = await db.get('SELECT * FROM productos WHERE id = ?', [req.params.id]);
    if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
    await db.run('UPDATE productos SET stock = stock + ?, precio_compra = COALESCE(?, precio_compra) WHERE id = ?',
      [cantidad, precio_compra || null, req.params.id]);
    await db.run('INSERT INTO entradas_inventario (producto_id, cantidad, precio_compra, nota) VALUES (?, ?, ?, ?)',
      [req.params.id, cantidad, precio_compra || null, nota || null]);
    res.json({ mensaje: 'Entrada registrada' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/entradas', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM entradas_inventario WHERE producto_id = ? ORDER BY fecha DESC', [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
