#!/usr/bin/env node
'use strict';

// Bootstraps the first system_admin user for local dev, since RBAC
// endpoints require an authenticated system_admin/owner user to create
// further users and there's otherwise no way to create the first one.
// Usage: SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... npm run seed:admin

require('dotenv').config();
const { Client } = require('pg');
const { hashPassword } = require('../utils/password');

async function run() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@swiftcedi.local';
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('SEED_ADMIN_PASSWORD env var is required');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows: existing } = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.length > 0) {
      console.log(`Admin user ${email} already exists (id ${existing[0].id}); nothing to do.`);
      return;
    }

    const { rows: roleRows } = await client.query("SELECT id FROM roles WHERE name = 'system_admin'");
    const { rows: branchRows } = await client.query("SELECT id FROM branches WHERE code = 'HQ'");
    if (!roleRows[0] || !branchRows[0]) {
      throw new Error('system_admin role or HQ branch not found — run migrations first');
    }

    const passwordHash = await hashPassword(password);
    const { rows } = await client.query(
      `INSERT INTO users (full_name, email, password_hash, role_id, home_branch_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email`,
      ['System Administrator', email, passwordHash, roleRows[0].id, branchRows[0].id]
    );
    console.log(`Created admin user ${rows[0].email} (id ${rows[0].id}).`);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
