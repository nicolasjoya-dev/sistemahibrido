process.env.TZ = 'America/Bogota';
const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/productos', require('./routes/productos'));
app.use('/api/ventas',    require('./routes/ventas'));
app.use('/api/facturas',  require('./routes/facturas'));
app.use('/api/ajustes',   require('./routes/ajustes'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en http://localhost:${PORT}`));