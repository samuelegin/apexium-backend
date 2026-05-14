require('dotenv').config();
const { createApp } = require('./app');
const PORT = process.env.PORT || 3000;

createApp().then(app => {
  app.listen(PORT, () => {
    console.log(`Apexium API  →  http://localhost:${PORT}/api`);
    console.log(`Health check →  http://localhost:${PORT}/api/health`);
  });
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});