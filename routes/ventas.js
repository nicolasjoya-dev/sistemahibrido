const express = require('express');
const router = express.Router();
const db = require('../db/init');

// ── POST nueva venta ──────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { items, descuento, efectivo, medio_pago } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'Carrito vacio' });

    let subtotal = 0;
    for (const item of items) subtotal += item.cantidad * item.precio_unitario;
    const desc   = descuento || 0;
    const total  = subtotal - desc;
    const mp     = medio_pago || 'efectivo';
    const ef     = mp === 'efectivo' ? (efectivo || null) : null;
    const vuelto = (mp === 'efectivo' && ef) ? ef - total : null;

    const r = await db.run(
      `INSERT INTO ventas (fecha, subtotal, descuento, total, efectivo, vuelto, medio_pago)
       VALUES (datetime('now','-5 hours'), ?, ?, ?, ?, ?, ?)`,
      [subtotal, desc, total, ef, vuelto, mp]
    );
    const ventaId = r.lastID;

    for (const item of items) {
      await db.run(
        `INSERT INTO venta_items (venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ventaId, item.producto_id, item.nombre_producto, item.cantidad,
         item.precio_unitario, item.cantidad * item.precio_unitario]
      );
      await db.run('UPDATE productos SET stock = stock - ? WHERE id = ?', [item.cantidad, item.producto_id]);
    }

    res.json({ id: ventaId, total, vuelto, medio_pago: mp, mensaje: 'Venta registrada' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET ventas ────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { fecha, desde, hasta } = req.query;
    let sql, params;
    const base = `SELECT v.*, GROUP_CONCAT(vi.nombre_producto || ' x' || vi.cantidad, ' | ') as productos_resumen
                  FROM ventas v LEFT JOIN venta_items vi ON v.id = vi.venta_id`;
    if (fecha) {
      sql = base + ` WHERE date(v.fecha) = ? GROUP BY v.id ORDER BY v.fecha DESC`;
      params = [fecha];
    } else if (desde && hasta) {
      sql = base + ` WHERE date(v.fecha) BETWEEN ? AND ? GROUP BY v.id ORDER BY v.fecha DESC`;
      params = [desde, hasta];
    } else {
      sql = base + ` WHERE date(v.fecha) = date('now','-5 hours') GROUP BY v.id ORDER BY v.fecha DESC`;
      params = [];
    }
    const rows = await db.all(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE venta + devolver stock ─────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const venta = await db.get('SELECT id FROM ventas WHERE id = ?', [id]);
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });

    // Recuperar items para devolver stock
    const items = await db.all('SELECT * FROM venta_items WHERE venta_id = ?', [id]);
    for (const item of items) {
      await db.run('UPDATE productos SET stock = stock + ? WHERE id = ?', [item.cantidad, item.producto_id]);
    }

    // Eliminar items y venta
    await db.run('DELETE FROM venta_items WHERE venta_id = ?', [id]);
    await db.run('DELETE FROM ventas WHERE id = ?', [id]);

    res.json({ mensaje: 'Venta eliminada y stock devuelto' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Calendario mes ────────────────────────────────────
router.get('/calendario/mes', async (req, res) => {
  try {
    const { anio, mes } = req.query;
    const y = anio || new Date().getFullYear();
    const m = (mes || new Date().getMonth() + 1).toString().padStart(2, '0');
    const rows = await db.all(
      `SELECT date(fecha) as dia, SUM(total) as total, COUNT(*) as num_ventas
       FROM ventas WHERE strftime('%Y-%m', fecha) = ? GROUP BY date(fecha)`,
      [`${y}-${m}`]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cierre historial ──────────────────────────────────
router.get('/cierre/historial', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM cierres_dia ORDER BY fecha DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cierre del día ────────────────────────────────────
router.post('/cierre/ejecutar', async (req, res) => {
  try {
    const hoy = new Date(new Date().getTime() - 5*60*60*1000).toISOString().split('T')[0];
    const ventasHoy = await db.all(
      `SELECT v.id, v.total, v.medio_pago, vi.producto_id, vi.cantidad, vi.precio_unitario, vi.nombre_producto
       FROM ventas v JOIN venta_items vi ON v.id = vi.venta_id WHERE date(v.fecha) = ?`, [hoy]
    );
    if (ventasHoy.length === 0) return res.json({ mensaje: 'Sin ventas hoy', total: 0, transacciones: 0, ganancia: 0, detalle: [], porMedioPago: {} });

    const ventasUnicas = await db.all(`SELECT id, total, medio_pago FROM ventas WHERE date(fecha) = ?`, [hoy]);
    const totalVentas = ventasUnicas.reduce((s, v) => s + v.total, 0);
    const numTx = ventasUnicas.length;

    // Totales por medio de pago
    const porMedioPago = { efectivo: 0, nequi: 0, daviplata: 0 };
    for (const v of ventasUnicas) {
      const mp = v.medio_pago || 'efectivo';
      porMedioPago[mp] = (porMedioPago[mp] || 0) + v.total;
    }

    const productosMap = {};
    for (const row of ventasHoy) {
      const prod = await db.get('SELECT precio_compra FROM productos WHERE id = ?', [row.producto_id]);
      if (!productosMap[row.producto_id]) {
        productosMap[row.producto_id] = { nombre: row.nombre_producto, vendido: 0, ganancia: 0 };
      }
      productosMap[row.producto_id].vendido += row.cantidad;
      const compra = prod ? prod.precio_compra : 0;
      productosMap[row.producto_id].ganancia += (row.precio_unitario - compra) * row.cantidad;
    }

    const detalle = Object.values(productosMap).sort((a, b) => b.vendido - a.vendido);
    const gananciaTotal = detalle.reduce((s, d) => s + d.ganancia, 0);
    const masVendido = detalle[0] ? detalle[0].nombre : 'N/A';

    const existeCierre = await db.get('SELECT id FROM cierres_dia WHERE fecha = ?', [hoy]);
    if (existeCierre) {
      await db.run('UPDATE cierres_dia SET total_ventas=?, num_transacciones=?, ganancia_total=?, detalle=? WHERE fecha=?',
        [totalVentas, numTx, gananciaTotal, JSON.stringify({ productos: detalle, porMedioPago }), hoy]);
    } else {
      await db.run('INSERT INTO cierres_dia (fecha, total_ventas, num_transacciones, ganancia_total, detalle) VALUES (?,?,?,?,?)',
        [hoy, totalVentas, numTx, gananciaTotal, JSON.stringify({ productos: detalle, porMedioPago })]);
    }
    res.json({ total: totalVentas, transacciones: numTx, ganancia: gananciaTotal, masVendido, detalle, porMedioPago });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET venta individual ──────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const venta = await db.get('SELECT * FROM ventas WHERE id = ?', [req.params.id]);
    if (!venta) return res.status(404).json({ error: 'No encontrada' });
    const items = await db.all('SELECT * FROM venta_items WHERE venta_id = ?', [req.params.id]);
    res.json({ ...venta, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;