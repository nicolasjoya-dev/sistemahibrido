# SistemaHíbrido 🏪

Sistema de inventario y ventas para miscelánea pequeña en Colombia.

## Stack
- **Frontend:** HTML + CSS + JavaScript puro (PWA instalable)
- **Backend:** Node.js + Express
- **Base de datos:** SQLite (better-sqlite3)
- **Deploy:** Railway

## Estructura del proyecto

```
sistemahibrido/
├── server.js              # Servidor Express
├── package.json
├── railway.toml           # Config Railway
├── db/
│   └── init.js            # Esquema y conexión SQLite
├── routes/
│   ├── productos.js       # CRUD inventario + entradas
│   ├── ventas.js          # Ventas, carrito, cierre del día
│   ├── facturas.js        # Generación PDF
│   └── ajustes.js         # Datos del negocio
└── public/
    ├── index.html         # SPA principal
    ├── manifest.json      # PWA manifest
    ├── sw.js              # Service Worker (offline)
    ├── css/style.css
    └── js/app.js
```

## Instalación local

```bash
cd sistemahibrido
npm install
npm start
# Abre http://localhost:3000
```

## Módulos incluidos

| Módulo | Funciones |
|--------|-----------|
| 📦 Inventario | Agregar/editar/eliminar productos, entradas de stock, alertas stock bajo |
| 🛒 Nueva Venta | Carrito con búsqueda, escáner código de barras, descuentos, vuelto |
| 🧾 Facturas | PDF descargable por venta (formato recibo 80mm) |
| 📅 Calendario | Vista mensual con totales por día, detalle al hacer clic |
| 📊 Informes | Filtro por rango de fechas, detalle por venta |
| 📋 Cierre del Día | Totales, ganancia, producto más vendido, historial |
| ⚙️ Ajustes | Nombre, dirección y teléfono del negocio para facturas |

## PWA / Offline
- Instala la app en PC desde Chrome → menú → "Instalar aplicación"
- Los assets estáticos se cachean automáticamente
- Las ventas e inventario requieren conexión para persistir en la BD

## Deploy en Railway
1. Sube el proyecto a GitHub
2. En Railway: New Project → Deploy from GitHub
3. Selecciona el repo → Railway detecta Node.js automáticamente
4. El archivo `railway.toml` ya está configurado

## Variables de entorno (Railway)
- `PORT` — Railway lo asigna automáticamente

## Notas
- La base de datos SQLite se crea automáticamente en `db/tienda.db`
- En Railway usa un volumen persistente si quieres que los datos sobrevivan deploys
- Los precios son en pesos colombianos (COP) sin decimales
