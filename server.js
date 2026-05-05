
process.env.TZ = 'America/Bogota';
const express   = require('express');
const app       = express();
const iaFactura = require('./routes/iaFactura');

app.use(express.json());
app.use('/api/ia', iaFactura);
app.use(express.static('public'));

app.listen(process.env.PORT || 3000, () => {
  console.log('Servidor listo en puerto', process.env.PORT || 3000);
});