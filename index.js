require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads')); // Раздача картинок

// Настройка Multer для загрузки картинок блюд
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Пул соединений
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Middleware проверки токена
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Forbidden for you' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Forbidden for you' });
    req.user = user;
    next();
  });
};

// 1. Регистрация
app.post('/registr', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 3) {
    return res.status(422).json({ message: 'Invalid fields', errors: { password: ['Too short'] } });
  }
  try {
    await pool.query('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', [email, password, 'client']);
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(422).json({ message: 'Invalid fields', errors: { email: ['Already exists'] } });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// 2. Авторизация
app.post('/auth', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(422).json({ message: 'Invalid data' });
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);
    if (!users.length) return res.status(422).json({ message: 'Invalid data', errors: { email: ['Invalid data'] } });
    const user = users[0];
    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. Получить все блюда (для Магазина)
app.get('/dishes', async (req, res) => {
  try {
    const [dishes] = await pool.query('SELECT * FROM dishes');
    res.json({ data: dishes });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 4. Получить одно блюдо (для карточки)
app.get('/dishes/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [dish] = await pool.query('SELECT * FROM dishes WHERE id = ?', [id]);
    if (!dish.length) return res.status(404).json({ error: 'Dish not found' });
    res.json({ data: dish[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 5. Добавить блюдо (Админка + загрузка картинки)
app.post('/dishes', authenticateToken, upload.single('img'), async (req, res) => {
  const { name, description, price, category } = req.body;
  const img = req.file ? req.file.path : null;
  
  if (!name || !price) return res.status(422).json({ message: 'Name and price required' });

  try {
    const [result] = await pool.query(
      'INSERT INTO dishes (name, description, price, img, category) VALUES (?, ?, ?, ?, ?)',
      [name, description, price, img, category]
    );
    res.status(201).json({ id: result.insertId, name, price, img });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 6. Редактировать блюдо
app.put('/dishes/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  const { name, description, price, category } = req.body;
  try {
    await pool.query(
      'UPDATE dishes SET name = ?, description = ?, price = ?, category = ? WHERE id = ?',
      [name, description, price, category, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 7. Удалить блюдо
app.delete('/dishes/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await pool.query('DELETE FROM dishes WHERE id = ?', [id]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 8. Поиск блюд по названию
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json({ data: [] });
  try {
    const [dishes] = await pool.query('SELECT * FROM dishes WHERE name LIKE ?', [`%${query}%`]);
    res.json({ data: dishes });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 9. Получить корзину пользователя
app.get('/cart', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const [cart] = await pool.query(`
      SELECT c.id, c.quantity, d.name, d.price, d.img 
      FROM cart c
      JOIN dishes d ON c.dish_id = d.id
      WHERE c.user_id = ?
    `, [userId]);
    res.json({ data: cart });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 10. Добавить в корзину
app.post('/cart', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { dish_id } = req.body;
  try {
    // Проверяем, есть ли уже это блюдо в корзине
    const [existing] = await pool.query('SELECT * FROM cart WHERE user_id = ? AND dish_id = ?', [userId, dish_id]);
    
    if (existing.length) {
      // Если есть, увеличиваем количество (но не больше 2, как в ТЗ)
      const newQuantity = existing[0].quantity + 1;
      if (newQuantity > 2) return res.status(400).json({ message: 'Лимит превышен (макс 2)' });
      await pool.query('UPDATE cart SET quantity = ? WHERE id = ?', [newQuantity, existing[0].id]);
    } else {
      // Если нет, добавляем новую запись
      await pool.query('INSERT INTO cart (user_id, dish_id, quantity) VALUES (?, ?, 1)', [userId, dish_id]);
    }
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 11. Изменить количество блюда в корзине
app.put('/cart/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  const { quantity } = req.body;
  const userId = req.user.id;
  
  if (quantity <= 0) {
    // Если количество 0 или меньше, удаляем
    await pool.query('DELETE FROM cart WHERE id = ? AND user_id = ?', [id, userId]);
    return res.status(204).send();
  }

  try {
    await pool.query('UPDATE cart SET quantity = ? WHERE id = ? AND user_id = ?', [quantity, id, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 12. Удалить из корзины
app.delete('/cart/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.user.id;
  try {
    await pool.query('DELETE FROM cart WHERE id = ? AND user_id = ?', [id, userId]);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 13. Оформить заказ (очистить корзину)
app.post('/checkout', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    await pool.query('DELETE FROM cart WHERE user_id = ?', [userId]);
    res.json({ status: 'success', message: 'Заказ оформлен' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Bread API running on http://localhost:${PORT}`);
});