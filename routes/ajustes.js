const express = require('express');
const router = express.Router();
const db = require('../db/init');

router.get('/', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM ajustes');
    const obj = {};
    rows.forEach(r => obj[r.clave] = r.valor);
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { nombre_negocio, direccion, telefono } = req.body;
    if (nombre_negocio !== undefined) await db.run('INSERT OR REPLACE INTO ajustes (clave, valor) VALUES (?, ?)', ['nombre_negocio', nombre_negocio]);
    if (direccion      !== undefined) await db.run('INSERT OR REPLACE INTO ajustes (clave, valor) VALUES (?, ?)', ['direccion', direccion]);
    if (telefono       !== undefined) await db.run('INSERT OR REPLACE INTO ajustes (clave, valor) VALUES (?, ?)', ['telefono', telefono]);
    res.json({ mensaje: 'Ajustes guardados' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
