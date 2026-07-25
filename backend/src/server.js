'use strict';

require('dotenv').config();
const { createApp } = require('./app');
const { getPool } = require('./db/pool');

const port = process.env.PORT || 4000;
const app = createApp(getPool());

app.listen(port, () => {
  console.log(`SwiftCedi backend listening on port ${port}`);
});
