require('dotenv').config();
const { createApp } = require('./app');
const { startIndexer } = require('./indexer');
const PORT = process.env.PORT || 3000;

createApp().then(app => {
  app.listen(PORT, () => {
    console.log(`Work3Labs API  →  http://localhost:${PORT}/api`);
    console.log(`Health check   →  http://localhost:${PORT}/api/health`);
  });
  
  startIndexer();
}).catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
