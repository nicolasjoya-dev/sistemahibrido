process.env.TZ = 'America/Bogota';
const express = require('express');
const app = express();
const iaFactura = require('./routes/iaFactura');
app.use('/api/ia', iaFactura);
app.use(express.static('public'));
app.listen(process.env.PORT || 3000);