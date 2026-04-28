const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_DIR  = path.join(__dirname, '..', 'db');
const DB_PATH = path.join(DB_DIR, 'tienda.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const _db = new sqlite3.Database(DB_PATH);

const db = {
  _raw: _db,
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      _db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  },
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      _db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      _db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  },
  exec(sql) {
    return new Promise((resolve, reject) => {
      _db.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS productos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    categoria TEXT,
    precio_compra REAL NOT NULL DEFAULT 0,
    precio_venta REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    stock_minimo INTEGER NOT NULL DEFAULT 5,
    codigo_barras TEXT,
    unidad TEXT NOT NULL DEFAULT 'unidades',
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS entradas_inventario (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    producto_id INTEGER NOT NULL,
    cantidad REAL NOT NULL,
    precio_compra REAL,
    nota TEXT,
    fecha TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (producto_id) REFERENCES productos(id)
  );
  CREATE TABLE IF NOT EXISTS ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT DEFAULT (datetime('now','localtime')),
    subtotal REAL NOT NULL,
    descuento REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    efectivo REAL,
    vuelto REAL,
    cerrada INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS venta_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venta_id INTEGER NOT NULL,
    producto_id INTEGER NOT NULL,
    nombre_producto TEXT NOT NULL,
    cantidad REAL NOT NULL,
    precio_unitario REAL NOT NULL,
    subtotal REAL NOT NULL,
    FOREIGN KEY (venta_id) REFERENCES ventas(id),
    FOREIGN KEY (producto_id) REFERENCES productos(id)
  );
  CREATE TABLE IF NOT EXISTS cierres_dia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    total_ventas REAL NOT NULL,
    num_transacciones INTEGER NOT NULL,
    ganancia_total REAL NOT NULL,
    detalle TEXT,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS ajustes (
    clave TEXT PRIMARY KEY,
    valor TEXT
  );
  INSERT OR IGNORE INTO ajustes (clave, valor) VALUES ('nombre_negocio', 'Mi Miscelanea');
  INSERT OR IGNORE INTO ajustes (clave, valor) VALUES ('direccion', 'Calle Principal 123');
  INSERT OR IGNORE INTO ajustes (clave, valor) VALUES ('telefono', '310 000 0000');
`;

_db.serialize(() => {
  _db.run('PRAGMA journal_mode = WAL');
  _db.run('PRAGMA foreign_keys = ON');
  _db.exec(SCHEMA, (err) => {
    if (err) console.error('Error BD:', err);
    else console.log('Base de datos lista');
  });
});

module.exports = db;
