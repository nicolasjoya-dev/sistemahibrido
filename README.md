# SistemaHibrido

Sistema web de inventario, ventas, facturas y codigos de barras para una tienda pequena.

## Stack actual

- Frontend: HTML, CSS y JavaScript puro en `public/`.
- Servidor: Node.js + Express solo para servir los archivos estaticos.
- Base de datos: Firebase Firestore desde el frontend autenticado.
- Deploy: Railway usando `server.js`.

## Estructura

```text
sistemahibrido/
├── server.js              # Servidor Express estatico
├── package.json
├── railway.toml
└── public/
    ├── index.html         # App principal
    ├── manifest.json      # PWA
    ├── sw.js              # Cache de assets
    ├── css/style.css
    ├── js/app.js
    └── vendor/            # Librerias locales de navegador
```

## Uso local

```bash
npm install
npm start
```

Despues abre `http://localhost:3000`.

## Funciones principales

- Dashboard con ventas, ganancia diaria y valor del inventario por precio de compra.
- Inventario con codigos de barras, scanner movil, alertas y centro de auditoria.
- Nueva venta con carrito, descuentos, stock transaccional y factura PDF.
- Etiquetas de codigos de barras con generacion individual, por lote y pendientes.
- Respaldo/exportacion en JSON, Excel y CSV.
- Importacion con previsualizacion y confirmacion antes de escribir en Firebase.

## Datos y seguridad

La app usa Firestore. Las reglas de Firebase deben limitar el acceso a los correos autorizados del negocio. Este repositorio no usa SQLite ni rutas API propias para guardar datos.

## Deploy en Railway

1. Sube los cambios a GitHub.
2. En Railway, despliega desde el repositorio.
3. Railway ejecuta `npm start`.
4. `PORT` lo asigna Railway automaticamente.
