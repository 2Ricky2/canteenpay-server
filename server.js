// server.js
const express = require('express');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== Static Images (uploads) =====
const IMAGES_DIR = path.join(__dirname, 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
app.use('/images', express.static(IMAGES_DIR));

// ===== PayPal sandbox stubs =====
app.get('/paypal-return', (req, res) => res.send('PayPal payment success (sandbox return)'));
app.get('/paypal-cancel', (req, res) => res.send('PayPal payment cancelled'));

// ===== PostgreSQL (Railway/local) =====
const isSSL = String(process.env.DB_SSL || '').toLowerCase() === 'true';
const pool = new Pool({
  host: String(process.env.DB_HOST || 'yamabiko.proxy.rlwy.net'),
  port: Number(process.env.DB_PORT || 34727),
  user: String(process.env.DB_USER || 'postgres'),
  password: String(process.env.DB_PASS || 'KgREPqRkVCCSNIqtVATphEKGgHedkiNx'),
  database: String(process.env.DB_NAME || 'railway'),
  ssl: isSSL ? { rejectUnauthorized: false } : false,
});

// ---- bootstrap: ensure required columns exist (idempotent) ----
async function ensureSchema() {
  await pool.query(`
    ALTER TABLE IF EXISTS menu_items
      ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE IF EXISTS users
      ADD COLUMN IF NOT EXISTS wallet NUMERIC(12,2) NOT NULL DEFAULT 0
  `);
}
ensureSchema().catch(e => console.error('Schema ensure failed:', e));

// ---- mysql2-compatible adapter for legacy db.query usage ----
function qmarkToDollar(sql) {
  // convert ?, ?, ?  -> $1, $2, $3 (safe for queries that don't already use $n)
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
const db = {
  connect(cb) {
    pool.connect()
      .then(c => { c.release(); cb && cb(); })
      .catch(err => cb && cb(err));
  },
  query(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    const rewritten = qmarkToDollar(sql);
    pool.query(rewritten, Array.isArray(params) ? params : [])
      .then(result => {
        const rows = result.rows || [];
        // attach affectedRows so existing code (mysql style) continues to work
        try { rows.affectedRows = typeof result.rowCount === 'number' ? result.rowCount : 0; } catch {}
        cb && cb(null, rows);
      })
      .catch(err => cb && cb(err));
  }
};

db.connect(err => {
  if (err) console.error('❌ DB connection failed:', err);
  else     console.log('✅ PostgreSQL pool ready');
});

// ===== Multer upload =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMAGES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// ===== Health (app + DB) =====
app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, db: r.rows[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// =========================
// AUTH
// =========================

// SIGNUP
app.post('/signup', async (req, res) => {
  const { user_name, user_email, user_pass } = req.body;
  if (!user_name || !user_email || !user_pass) {
    return res.json({ success: false, message: 'All fields required' });
  }

  db.query('SELECT * FROM users WHERE user_email = ?', [user_email], async (err, results) => {
    if (err) return res.json({ success: false, message: 'DB error' });
    if (results.length > 0)
      return res.json({ success: false, message: 'Email already exists' });

    const hashed = await bcrypt.hash(user_pass, 10);
    db.query(
      'INSERT INTO users (user_name, user_email, user_pass, role, wallet) VALUES (?, ?, ?, ?, ?)',
      [user_name, user_email, hashed, 'user', 0.00],
      (err2) => {
        if (err2) return res.json({ success: false, message: 'Insert error' });
        return res.json({ success: true, message: 'User created successfully' });
      }
    );
  });
});

// LOGIN
app.post('/login', (req, res) => {
  const { user_email, user_pass } = req.body;
  if (!user_email || !user_pass)
    return res.json({ success: false, message: 'All fields required' });

  db.query('SELECT * FROM users WHERE user_email = ?', [user_email], async (err, results) => {
    if (err) return res.json({ success: false, message: 'DB error' });
    if (results.length === 0)
      return res.json({ success: false, message: 'User not found' });

    const user = results[0];
    const isMatch = await bcrypt.compare(user_pass, user.user_pass);
    if (!isMatch)
      return res.json({ success: false, message: 'Invalid password' });

    return res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.user_id,
        username: user.user_name,
        email: user.user_email,
        role: user.role,
        wallet: Number(user.wallet || 0),
      }
    });
  });
});

// =========================
// MENU
// =========================

// Get items
app.get('/menu', (req, res) => {
  db.query('SELECT id, name, category, price, image_url, quantity FROM menu_items ORDER BY id DESC', (err, results) => {
    if (err) {
      console.error(err);
      return res.json({ success: false, message: 'DB fetch error' });
    }
    res.json({ success: true, menu: results });
  });
});

// Add item
app.post('/menu', (req, res) => {
  const { name, category, price, image_url, quantity } = req.body;
  if (!name || !category || price === undefined) {
    return res.json({ success: false, message: 'Missing required fields' });
  }

  const sql = 'INSERT INTO menu_items (name, category, price, image_url, quantity) VALUES ($1, $2, $3, $4, $5)';
  db.query(sql, [name, category, price, image_url || '', quantity || 0], (err) => {
    if (err) {
      console.error(err);
      return res.json({ success: false, message: 'DB insert error' });
    }
    res.json({ success: true, message: 'Item added successfully' });
  });
});

// Update item
app.put('/menu/:id', (req, res) => {
  const { id } = req.params;
  const { name, category, price, image_url, quantity } = req.body;

  const sql = `
    UPDATE menu_items 
    SET name = $1, category = $2, price = $3, image_url = $4, quantity = $5
    WHERE id = $6
  `;
  db.query(sql, [name, category, price, image_url || '', quantity || 0, id], (err, result) => {
    if (err) {
      console.error(err);
      return res.json({ success: false, message: 'DB update error' });
    }
    res.json({ success: true, message: 'Item updated successfully' });
  });
});

// Delete item
app.delete('/menu/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM menu_items WHERE id = $1', [id], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Delete failed' });
    const affected = rows.affectedRows || 0;
    res.json({ success: affected > 0, message: affected > 0 ? 'Food item deleted successfully' : 'Item not found' });
  });
});

// Upload image
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.json({ success: false, message: 'No file uploaded' });
  res.json({ success: true, filename: req.file.filename, url: `/images/${req.file.filename}` });
});

// =========================
/** ORDERS
 * IMPORTANT: more specific /orders/all/:user_id MUST come before /orders/:user_id
 */
// =========================

// Place order (decrement stock safely)
app.post('/order', (req, res) => {
  const { user_id, menu_id } = req.body;
  if (!user_id || !menu_id) return res.json({ success: false, message: 'Missing data' });

  // 1) check item
  db.query('SELECT price, quantity FROM menu_items WHERE id = $1', [menu_id], (err, rows) => {
    if (err || rows.length === 0) return res.json({ success: false, message: 'Food not found' });
    const item = rows[0];
    if (Number(item.quantity) <= 0) return res.json({ success: false, message: 'Out of stock' });

    // 2) decrement atomically + create order
    db.query('UPDATE menu_items SET quantity = quantity - 1 WHERE id = $1 AND quantity > 0', [menu_id], (err2, upd) => {
      if (err2) return res.json({ success: false, message: 'Stock update error' });
      const affected = (upd && upd.affectedRows) || 0;
      if (affected === 0) return res.json({ success: false, message: 'Out of stock' });

      db.query(
        'INSERT INTO orders (user_id, menu_id, quantity, total_price, status) VALUES ($1, $2, $3, $4, $5)',
        [user_id, menu_id, 1, Number(item.price), 'Pending'],
        (err3) => {
          if (err3) return res.json({ success: false, message: 'Failed to order' });
          res.json({ success: true, message: 'Order placed successfully!' });
        }
      );
    });
  });
});

// ALL orders for a user
app.get('/orders/all/:user_id', (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ success: false, message: 'Invalid user_id' });
  }
  const sql = `
    SELECT 
      o.id,
      o.status,
      o.quantity,
      o.total_price,
      m.name  AS food_name,
      m.price,
      m.image_url
    FROM orders o
    LEFT JOIN menu_items m ON o.menu_id = m.id
    WHERE o.user_id = $1
    ORDER BY o.created_at DESC, o.id DESC
  `;
  db.query(sql, [userId], (err, rows) => {
    if (err) return res.json({ success: false, message: 'DB error' });
    res.json({ success: true, orders: rows });
  });
});

// ACTIVE orders (Pending/Preparing/Paid)
app.get('/orders/:user_id', (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ success: false, message: 'Invalid user_id' });
  }
  const ACTIVE = ['Pending', 'Preparing', 'Paid'];
  const sql = `
    SELECT 
      o.id,
      o.status,
      o.quantity,
      o.total_price,
      m.name  AS food_name,
      m.price,
      m.image_url
    FROM orders o
    LEFT JOIN menu_items m ON o.menu_id = m.id
    WHERE o.user_id = $1
      AND o.status = ANY($2::text[])
    ORDER BY o.created_at DESC, o.id DESC
  `;
  db.query(sql, [userId, ACTIVE], (err, rows) => {
    if (err) return res.json({ success: false, message: 'DB error' });
    res.json({ success: true, orders: rows });
  });
});

// Delete single order
app.delete('/orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sql = 'DELETE FROM orders WHERE id = $1';
  db.query(sql, [id], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Database error' });
    const affected = rows.affectedRows || 0;
    res.json({ success: affected > 0, message: affected > 0 ? 'Order deleted successfully' : 'Order not found' });
  });
});

// Delete PAID orders for user
app.delete('/orders/deletePaid/:user_id', (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  const sql = 'DELETE FROM orders WHERE user_id = $1 AND status = $2';
  db.query(sql, [userId, 'Paid'], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Database error' });
    const affected = rows.affectedRows || 0;
    res.json({
      success: affected > 0,
      deleted: affected,
      message: affected > 0 ? `${affected} paid orders deleted for user ${userId}.` : 'No paid orders found for this user.',
    });
  });
});

// Update an order’s status (admin)
app.put('/orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;

  if (!status) return res.json({ success: false, message: 'Missing status' });
  const valid = ['Active', 'Paid', 'Completed', 'Cancelled', 'Pending', 'Preparing'];
  if (!valid.includes(status)) return res.json({ success: false, message: 'Invalid status value' });

  const sql = 'UPDATE orders SET status = $1 WHERE id = $2';
  db.query(sql, [status, id], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Database update error' });
    res.json({ success: true, message: `Order marked as ${status}` });
  });
});

// Mark all user's Pending/Active/Preparing orders as Paid
app.put('/orders/markPaid/:userId', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const toPay = ['Pending', 'Active', 'Preparing'];
  const sql = 'UPDATE orders SET status = $1 WHERE user_id = $2 AND status = ANY($3::text[])';
  db.query(sql, ['Paid', userId, toPay], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Error updating orders' });
    const affected = rows.affectedRows || 0;
    res.json({ success: true, updated: affected });
  });
});

// Delete COMPLETED orders for user
app.delete('/orders/deleteCompleted/:user_id', (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  const sql = 'DELETE FROM orders WHERE user_id = $1 AND LOWER(status) = $2';
  db.query(sql, [userId, 'completed'], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Database error' });
    const affected = rows.affectedRows || 0;
    res.json({
      success: affected > 0,
      deleted: affected,
      message: affected > 0 ? `${affected} completed orders deleted for user ${userId}.` : 'No completed orders found for this user.',
    });
  });
});

// =========================
// USERS (admin)
// =========================
app.get('/users', (req, res) => {
  db.query(
    'SELECT user_id, user_name, user_email, role, wallet FROM users ORDER BY user_id DESC',
    (err, results) => {
      if (err) return res.json({ success: false, message: 'DB error' });
      res.json({ success: true, users: results });
    }
  );
});

app.put('/users/:id', (req, res) => {
  const { user_name, role, wallet } = req.body;
  const { id } = req.params;
  const sql = 'UPDATE users SET user_name = $1, role = $2, wallet = $3 WHERE user_id = $4';
  db.query(sql, [user_name, role, wallet, id], err => {
    if (err) return res.json({ success: false, message: 'DB update error' });
    res.json({ success: true, message: 'User updated' });
  });
});

app.delete('/users/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM users WHERE user_id = $1', [id], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Delete failed' });
    const affected = rows.affectedRows || 0;
    res.json({ success: affected > 0, message: affected > 0 ? 'User deleted successfully' : 'User not found' });
  });
});

// =========================
// WALLET
// =========================
app.get('/wallet/:user_id', (req, res) => {
  const { user_id } = req.params;
  db.query('SELECT wallet FROM users WHERE user_id = $1', [user_id], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Database error' });
    if (rows.length === 0) return res.json({ success: false, message: 'User not found' });
    res.json({ success: true, wallet: Number(rows[0].wallet || 0) });
  });
});

app.put('/wallet/add/:user_id', (req, res) => {
  const { user_id } = req.params;
  const { amount } = req.body;
  if (amount === undefined || isNaN(amount)) return res.json({ success: false, message: 'Invalid amount' });

  const sql = 'UPDATE users SET wallet = wallet + $1 WHERE user_id = $2';
  db.query(sql, [amount, user_id], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Database error' });
    const affected = rows.affectedRows || 0;
    if (affected === 0) return res.json({ success: false, message: 'User not found' });
    res.json({ success: true, message: 'Wallet updated successfully' });
  });
});

app.put('/wallet/deduct/:user_id', (req, res) => {
  const { user_id } = req.params;
  const { amount } = req.body;
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.json({ success: false, message: 'Invalid amount' });
  }

  const sql = `
    UPDATE users 
    SET wallet = wallet - $1 
    WHERE user_id = $2 AND wallet >= $1
  `;
  db.query(sql, [amount, user_id], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Database error' });
    const affected = rows.affectedRows || 0;
    if (affected === 0) {
      return res.json({ success: false, message: 'Insufficient wallet balance or user not found.' });
    }
    res.json({ success: true, message: `₱${amount} deducted from wallet.` });
  });
});

// =========================
// ADMIN: transactions
// =========================
app.get('/admin/transactions', (req, res) => {
  const statuses = ['Paid', 'Completed'];
  const sql = `
    SELECT 
      o.id, 
      o.total_price, 
      o.status, 
      o.created_at, 
      u.user_name, 
      m.name AS food_name
    FROM orders o
    JOIN users u ON o.user_id = u.user_id
    JOIN menu_items m ON o.menu_id = m.id
    WHERE o.status = ANY($1::text[])
    ORDER BY o.created_at DESC, o.id DESC
  `;
  db.query(sql, [statuses], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Database error' });
    res.json({ success: true, transactions: rows });
  });
});

app.delete('/admin/transactions/clear', (req, res) => {
  const statuses = ['Paid', 'Completed'];
  const sql = `DELETE FROM orders WHERE status = ANY($1::text[])`;
  db.query(sql, [statuses], (err, rows) => {
    if (err) return res.json({ success: false, message: 'Database error' });
    const affected = rows.affectedRows || 0;
    res.json({ success: true, message: `Deleted ${affected} transaction logs.` });
  });
});

// =========================
// START
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
});
