const express = require('express');
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ Serve local images (food pictures)
app.use('/images', express.static(path.join(__dirname, 'images')));

// Minimal PayPal redirects (sandbox)
app.get('/paypal-return', (req, res) => res.send('PayPal payment success (sandbox return)'));
app.get('/paypal-cancel', (req, res) => res.send('PayPal payment cancelled'));


// === PostgreSQL (Railway) ===
const pool = new Pool({
  host: process.env.DB_HOST || "yamabiko.proxy.rlwy.net",
  port: process.env.DB_PORT || 34727,
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASS || "KgREPqRkVCCSNIqtVATphEKGgHedkiNx",
  database: process.env.DB_NAME || "railway",
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// MySQL->PG compatibility wrapper
function qmarkToDollar(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    i += 1;
    return `$${i}`;
  });
}

const db = {
  connect(cb) {
    pool.connect()
      .then(client => { client.release(); cb && cb(); })
      .catch(err => { cb && cb(err); });
  },
  query(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    const rewritten = qmarkToDollar(sql);
    pool.query(rewritten, Array.isArray(params) ? params : [])
      .then(result => {
        // Align with mysql2 callback shape
        const resShape = {
          rows: result.rows,
          affectedRows: result.rowCount ?? 0,
        };
        cb && cb(null, resShape.rows || resShape);
      })
      .catch(err => cb && cb(err));
  }
};
db.connect(err => {
  if (err) {
    console.error('❌ DB connection failed:', err);
  } else {
    console.log('✅ PostgreSQL pool ready');
  }
});




//SIGNUP
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
      err2 => {
        if (err2)
          return res.json({ success: false, message: 'Insert error' });
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
        wallet: user.wallet || 0.00,
      }
    });
  });
});




//Get items
app.get('/menu', (req, res) => {
  db.query('SELECT * FROM menu_items', (err, results) => {
    if (err) {
      console.error(err);
      return res.json({ success: false, message: 'DB fetch error' });
    }
    res.json({ success: true, menu: results });
  });
});

//Add item
app.post('/menu', (req, res) => {
  const { name, category, price, image_url, quantity } = req.body;
  if (!name || !category || !price) {
    return res.json({ success: false, message: 'Missing required fields' });
  }

  const sql = 'INSERT INTO menu_items (name, category, price, image_url, quantity) VALUES (?, ?, ?, ?, ?)';
  db.query(sql, [name, category, price, image_url || '', quantity || 0], (err) => {
    if (err) {
      console.error(err);
      return res.json({ success: false, message: 'DB insert error' });
    }
    res.json({ success: true, message: 'Item added successfully' });
  });
});

//Update item
app.put('/menu/:id', (req, res) => {
  const { id } = req.params;
  const { name, category, price, image_url, quantity } = req.body;

  const sql = `
    UPDATE menu_items 
    SET name=?, category=?, price=?, image_url=?, quantity=? 
    WHERE id=?`;
  
  db.query(sql, [name, category, price, image_url || '', quantity || 0, id], (err) => {
    if (err) {
      console.error(err);
      return res.json({ success: false, message: 'DB update error' });
    }
    res.json({ success: true, message: 'Item updated successfully' });
  });
});

//Delete item
app.delete('/menu/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM menu_items WHERE id=?', [id], err => {
    if (err) return res.json({ success: false, message: 'Delete failed' });
    res.json({ success: true, message: 'Food item deleted successfully' });
  });
});


//
//ADMIN


// ✅ Fetch all users
app.get('/users', (req, res) => {
  db.query(
    'SELECT user_id, user_name, user_email, role, wallet FROM users',
    (err, results) => {
      if (err) return res.json({ success: false, message: 'DB error' });
      res.json({ success: true, users: results });
    }
  );
});
// ✅ UPDATE user info
app.put('/users/:id', (req, res) => {
  const { user_name, role, wallet } = req.body;
  const { id } = req.params;

  const sql = 'UPDATE users SET user_name=?, role=?, wallet=? WHERE user_id=?';
  db.query(sql, [user_name, role, wallet, id], err => {
    if (err) return res.json({ success: false, message: 'DB update error' });
    res.json({ success: true, message: 'User updated' });
  });
});

// ✅ Delete a user
app.delete('/users/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM users WHERE user_id = ?', [id], err => {
    if (err) return res.json({ success: false, message: 'Delete failed' });
    res.json({ success: true, message: 'User deleted successfully' });
  });
});

const multer = require('multer');
const upload = multer({ dest: path.join(__dirname, 'images') });

app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.json({ success: false, message: 'No file uploaded' });
  res.json({ success: true, filename: req.file.filename });
});


// ✅ PLACE ORDER
app.post('/order', (req, res) => {
  const { user_id, menu_id } = req.body;
  if (!user_id || !menu_id)
    return res.json({ success: false, message: 'Missing data' });

  db.query('SELECT * FROM menu_items WHERE id = ?', [menu_id], (err, results) => {
    if (err || results.length === 0) return res.json({ success: false, message: 'Food not found' });

    const item = results[0];
    if (item.quantity <= 0) return res.json({ success: false, message: 'Out of stock' });

    const totalPrice = item.price;

    // ✅ Reduce stock
    db.query('UPDATE menu_items SET quantity = quantity - 1 WHERE id = ?', [menu_id]);

    // ✅ Create order
    db.query(
      'INSERT INTO orders (user_id, menu_id, quantity, total_price) VALUES (?, ?, ?, ?)',
      [user_id, menu_id, 1, totalPrice],
      (err2) => {
        if (err2) return res.json({ success: false, message: 'Failed to order' });
        res.json({ success: true, message: 'Order placed successfully!' });
      }
    );
  });
});

// ✅ FETCH USER’S ACTIVE ORDERS (with quantity)
app.get('/orders/:user_id', (req, res) => {
  const { user_id } = req.params;
  const sql = `
    SELECT 
      o.id, 
      o.status, 
      o.quantity, 
      o.total_price, 
      m.name AS food_name, 
      m.price, 
      m.image_url
    FROM orders o
    JOIN menu_items m ON o.menu_id = m.id
    WHERE o.user_id = ?
    ORDER BY o.id DESC
  `;

  db.query(sql, [user_id], (err, results) => {
    if (err) {
      console.error(err);
      return res.json({ success: false, message: 'DB error' });
    }
    res.json({ success: true, orders: results });
  });
});
app.get('/orders/all/:user_id', (req, res) => {
  const { user_id } = req.params;
  const sql = `
    SELECT 
      o.id, 
      o.status, 
      o.quantity, 
      o.total_price, 
      m.name AS food_name, 
      m.price, 
      m.image_url
    FROM orders o
    JOIN menu_items m ON o.menu_id = m.id
    WHERE o.user_id = ?
    ORDER BY o.id DESC
  `;

  db.query(sql, [user_id], (err, results) => {
    if (err) {
      console.error(err);
      return res.json({ success: false, message: 'DB error' });
    }
    res.json({ success: true, orders: results });
  });
});
app.delete('/orders/:id', (req, res) => {
  const { id } = req.params;
  const sql = 'DELETE FROM orders WHERE id = ?';

  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error('Error deleting order:', err);
      return res.json({ success: false, message: 'Database error' });
    }

    if (result.affectedRows > 0) {
      res.json({ success: true, message: 'Order deleted successfully' });
    } else {
      res.json({ success: false, message: 'Order not found' });
    }
  });
});
app.delete('/orders/deletePaid/:user_id', (req, res) => {
  const { user_id } = req.params;
  const sql = `
    DELETE FROM orders 
    WHERE user_id = ? 
    AND status = 'Paid'
  `;

  db.query(sql, [user_id], (err, result) => {
    if (err) {
      console.error('Error deleting paid orders:', err);
      return res.json({ success: false, message: 'Database error' });
    }

    if (result.affectedRows > 0) {
      res.json({
        success: true,
        deleted: result.affectedRows,
        message: `${result.affectedRows} paid orders deleted for user ${user_id}.`,
      });
    } else {
      res.json({
        success: false,
        message: 'No paid orders found for this user.',
      });
    }
  });
});




// 1) ALL orders for a user (put this first)
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
    if (err) {
      console.error('orders/all DB error:', err.message || err);
      return res.json({ success: false, message: 'DB error' });
    }
    res.json({ success: true, orders: rows });
  });
});

// 2) ACTIVE orders only (keep the original path your app calls)
app.get('/orders/:user_id', (req, res) => {
  const userId = parseInt(req.params.user_id, 10);
  if (!Number.isInteger(userId)) {
    return res.status(400).json({ success: false, message: 'Invalid user_id' });
  }

  // tweak this list if your "active" definition changes
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
      AND o.status IN ('Pending','Preparing','Paid')
    ORDER BY o.created_at DESC, o.id DESC
  `;

  db.query(sql, [userId], (err, rows) => {
    if (err) {
      console.error('orders (active) DB error:', err.message || err);
      return res.json({ success: false, message: 'DB error' });
    }
    res.json({ success: true, orders: rows });
  });
});



app.put('/orders/markPaid/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = 'UPDATE orders SET status = "Paid" WHERE user_id = ? AND status IN ("Pending", "Active")';

  db.query(sql, [userId], (err, result) => {
    if (err) {
      console.error('DB error:', err);
      return res.json({ success: false, message: 'Error updating orders' });
    }
    res.json({ success: true, updated: result.affectedRows });
  });
});

// ✅ Delete all COMPLETED orders (case-insensitive, works with 'Completed' or 'completed')
app.delete('/orders/deleteCompleted/:user_id', (req, res) => {
  const { user_id } = req.params;

  const sql = `
    DELETE FROM orders 
    WHERE user_id = ? 
    AND LOWER(status) = 'completed'
  `;

  db.query(sql, [user_id], (err, result) => {
    if (err) {
      console.error('Error deleting completed orders:', err);
      return res.json({ success: false, message: 'Database error' });
    }

    if (result.affectedRows > 0) {
      res.json({
        success: true,
        deleted: result.affectedRows,
        message: `${result.affectedRows} completed orders deleted for user ${user_id}.`,
      });
    } else {
      res.json({
        success: false,
        message: 'No completed orders found for this user.',
      });
    }
  });
});

// ✅ WALLET ENDPOINTS
app.get('/wallet/:user_id', (req, res) => {
  const { user_id } = req.params;
  db.query('SELECT wallet FROM users WHERE user_id = ?', [user_id], (err, results) => {
    if (err) return res.json({ success: false, message: 'Database error' });
    if (results.length === 0)
      return res.json({ success: false, message: 'User not found' });
    res.json({ success: true, wallet: results[0].wallet });
  });
});

app.put('/wallet/add/:user_id', (req, res) => {
  const { user_id } = req.params;
  const { amount } = req.body;
  if (!amount || isNaN(amount))
    return res.json({ success: false, message: 'Invalid amount' });

  const sql = 'UPDATE users SET wallet = wallet + ? WHERE user_id = ?';
  db.query(sql, [amount, user_id], (err, result) => {
    if (err) {
      console.error('Wallet update error:', err);
      return res.json({ success: false, message: 'Database error' });
    }
    if (result.affectedRows === 0)
      return res.json({ success: false, message: 'User not found' });
    res.json({ success: true, message: 'Wallet updated successfully' });
  });
});

// ✅ Deduct wallet balance after payment
app.put('/wallet/deduct/:user_id', (req, res) => {
  const { user_id } = req.params;
  const { amount } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.json({ success: false, message: 'Invalid amount' });
  }

  const sql = `
    UPDATE users 
    SET wallet = wallet - ? 
    WHERE user_id = ? AND wallet >= ?`;

  db.query(sql, [amount, user_id, amount], (err, result) => {
    if (err) {
      console.error(' Wallet deduction error:', err);
      return res.json({ success: false, message: 'Database error' });
    }

    if (result.affectedRows === 0) {
      return res.json({
        success: false,
        message: 'Insufficient wallet balance or user not found.',
      });
    }

    res.json({
      success: true,
      message: `₱${amount} deducted from wallet.`,
    });
  });
});

// ✅ Admin view: all paid orders and wallet logs
app.get('/admin/transactions', (req, res) => {
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
    WHERE o.status IN ('Paid', 'Completed')
    ORDER BY o.id DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error('DB error:', err);
      return res.json({ success: false, message: 'Database error' });
    }
    res.json({ success: true, transactions: results });
  });
});
// ✅ Admin: delete all completed/paid transactions
app.delete('/admin/transactions/clear', (req, res) => {
  const sql = `
    DELETE FROM orders 
    WHERE status IN ('Paid', 'Completed')
  `;

  db.query(sql, (err, result) => {
    if (err) {
      console.error('Error clearing transactions:', err);
      return res.json({ success: false, message: 'Database error' });
    }

    res.json({
      success: true,
      message: `Deleted ${result.affectedRows} transaction logs.`,
    });
  });
});




// =========================
// 🚀 START SERVER
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('✅ Server running on http://localhost:3000')
);
