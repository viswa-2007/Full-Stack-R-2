const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_ISSUER = 'agri-connect';
const JWT_AUDIENCE = 'agri-connect-web';
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' || process.env.VERCEL
  ? null
  : crypto.randomBytes(32).toString('hex'));
if (!JWT_SECRET) throw new Error('Set JWT_SECRET to a strong random value before starting in production.');

// ---- tiny JSON "database" ----
const seedDB = path.join(__dirname, 'data.json');
const DB = process.env.VERCEL ? path.join('/tmp', 'agriconnect-data.json') : seedDB;
if (process.env.VERCEL && !fs.existsSync(DB) && fs.existsSync(seedDB)) {
  fs.copyFileSync(seedDB, DB);
}
const load = () => fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : { users: [], products: [], orders: [] };
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const uid = () => crypto.randomBytes(6).toString('hex');
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

function authenticatedUser(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) return null;
  try {
    const claims = jwt.verify(match[1], JWT_SECRET, {
      algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE
    });
    const account = load().users.find(u => u.id === claims.sub);
    if (!account || account.role !== claims.role) return null;
    return { id: account.id, name: account.name, role: account.role };
  } catch {
    return null;
  }
}

function auth(role) {
  return (req, res, next) => {
    const user = authenticatedUser(req);
    if (!user) return res.status(401).json({ error: 'Please log in again' });
    if (role && user.role !== role) return res.status(403).json({ error: 'Not allowed for your role' });
    req.user = user;
    next();
  };
}

// ---- auth ----
app.post('/api/register', (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 100 ||
      typeof email !== 'string' || !email.trim() || email.length > 254 ||
      typeof password !== 'string' || password.length < 8 || password.length > 128 ||
      !['farmer', 'buyer'].includes(role))
    return res.status(400).json({ error: 'Enter a name, valid email, password (8-128 characters), and role' });
  const d = load();
  const normalizedEmail = email.trim().toLowerCase();
  if (d.users.find(u => u.email === normalizedEmail))
    return res.status(400).json({ error: 'Email already registered' });
  const salt = uid();
  d.users.push({ id: uid(), name: name.trim(), email: normalizedEmail, role, salt, pw: hash(password, salt) });
  save(d);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = load().users.find(x => x.email === (typeof email === 'string' ? email : '').trim().toLowerCase());
  if (!u || typeof password !== 'string' || !crypto.timingSafeEqual(
    Buffer.from(u.pw, 'hex'), Buffer.from(hash(password, u.salt), 'hex')
  ))
    return res.status(401).json({ error: 'Wrong email or password' });
  const user = { id: u.id, name: u.name, role: u.role };
  const token = jwt.sign({ role: user.role }, JWT_SECRET, {
    algorithm: 'HS256', subject: user.id, issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE, expiresIn: '1h'
  });
  res.json({ token, user });
});

// ---- products ----
app.get('/api/products', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const user = authenticatedUser(req);
  const list = load().products.filter(p => p.quantity > 0 || user);
  res.json(list.filter(p => !q || (p.name + p.category + p.location).toLowerCase().includes(q)));
});

app.post('/api/products', auth('farmer'), (req, res) => {
  const { name, category, price, quantity, location } = req.body;
  if (!name || !(price > 0) || !(quantity > 0)) return res.status(400).json({ error: 'Enter valid name, price and quantity' });
  const d = load();
  d.products.push({ id: uid(), farmerId: req.user.id, farmerName: req.user.name, name, category, price: Number(price), quantity: Number(quantity), location });
  save(d);
  res.json({ ok: true });
});

app.delete('/api/products/:id', auth('farmer'), (req, res) => {
  const d = load();
  d.products = d.products.filter(p => !(p.id === req.params.id && p.farmerId === req.user.id));
  save(d);
  res.json({ ok: true });
});

// ---- market trends (average price per product) ----
app.get('/api/trends', (req, res) => {
  const g = {};
  load().products.forEach(p => {
    const k = p.name.trim().toLowerCase();
    (g[k] = g[k] || []).push(p.price);
  });
  res.json(Object.entries(g).map(([name, a]) => ({
    name, listings: a.length,
    avg: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2),
    min: Math.min(...a), max: Math.max(...a)
  })));
});

// ---- orders ----
app.post('/api/orders', auth('buyer'), (req, res) => {
  const d = load();
  const p = d.products.find(x => x.id === req.body.productId);
  const q = Number(req.body.quantity);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  if (!(q > 0) || q > p.quantity) return res.status(400).json({ error: 'Invalid quantity (available: ' + p.quantity + ')' });
  p.quantity -= q;
  d.orders.push({ id: uid(), productId: p.id, productName: p.name, farmerId: p.farmerId, buyerId: req.user.id,
    buyerName: req.user.name, quantity: q, total: q * p.price, status: 'Pending', date: new Date().toISOString() });
  save(d);
  res.json({ ok: true });
});

app.get('/api/orders', auth(), (req, res) => {
  const key = req.user.role === 'farmer' ? 'farmerId' : 'buyerId';
  res.json(load().orders.filter(o => o[key] === req.user.id).reverse());
});

app.patch('/api/orders/:id', auth('farmer'), (req, res) => {
  const d = load();
  const o = d.orders.find(x => x.id === req.params.id && x.farmerId === req.user.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  o.status = 'Delivered';
  save(d);
  res.json({ ok: true });
});

// ---- fertilizer suggestions (approx. kg of nutrient per acre; N-P-K) ----
const FERT = {
  rice:      { n: 48, p: 24, k: 24, timing: 'Half N + all P and K at transplanting; remaining N split at tillering and panicle initiation.', organic: 'Green manure or 2 tons farmyard manure (FYM) per acre before puddling.', tip: 'Avoid excess urea; it increases pest and lodging problems.' },
  wheat:     { n: 48, p: 24, k: 16, timing: 'Half N + all P and K at sowing; remaining N after first irrigation (about 20-25 days).', organic: '2-4 tons FYM or compost per acre before sowing.', tip: 'Apply zinc sulphate if soil is zinc deficient.' },
  maize:     { n: 48, p: 24, k: 16, timing: 'All P and K at sowing; N in 3 splits: sowing, knee-high stage, tasseling.', organic: '4 tons FYM per acre before sowing.', tip: 'Maize responds well to zinc; get a soil test.' },
  tomato:    { n: 48, p: 24, k: 24, timing: 'All P and half K at planting; N and remaining K in 3 splits every 3 weeks.', organic: '8-10 tons FYM per acre at land preparation.', tip: 'Add calcium or avoid uneven watering to reduce blossom-end rot.' },
  potato:    { n: 60, p: 24, k: 40, timing: 'Full P and K and half N at planting; remaining N at earthing up (25-30 days).', organic: '4-8 tons FYM per acre before planting.', tip: 'Potato needs plenty of potash for tuber quality.' },
  onion:     { n: 40, p: 20, k: 20, timing: 'Half N + all P and K at transplanting; rest of N about 30 days later.', organic: '4-6 tons FYM per acre.', tip: 'Stop nitrogen 3-4 weeks before harvest for better storage.' },
  cotton:    { n: 48, p: 24, k: 24, timing: 'N in 3 splits: basal, square formation, flowering. P and K basal.', organic: '4 tons FYM per acre.', tip: 'Spray 2% DAP or potassium nitrate at boll development if needed.' },
  groundnut: { n: 8, p: 16, k: 16, timing: 'All basal at sowing. Apply gypsum (about 80 kg per acre) at flowering.', organic: '2 tons FYM per acre; treat seed with Rhizobium culture.', tip: 'Gypsum improves pod filling; groundnut fixes its own nitrogen.' },
  chilli:    { n: 48, p: 24, k: 24, timing: 'All P and half K basal; N and rest of K in 3 splits after transplanting.', organic: '4-6 tons FYM per acre.', tip: 'Do not over-apply nitrogen; it reduces flowering.' },
  sugarcane: { n: 100, p: 40, k: 48, timing: 'All P and part K basal; N in 3 splits at 30, 60 and 90 days.', organic: '8 tons FYM or press mud per acre.', tip: 'Earth up after the last N dose.' },
  chickpea:  { n: 8, p: 16, k: 8, timing: 'All basal at sowing.', organic: '2 tons FYM per acre; treat seed with Rhizobium.', tip: 'Pulses fix nitrogen, so extra urea is not needed.' },
  brinjal:   { n: 40, p: 20, k: 20, timing: 'All P and half K at planting; N and rest of K in 3 splits.', organic: '6-8 tons FYM per acre.', tip: 'Regular light irrigation along with fertilizer gives best fruit set.' }
};

app.get('/api/fertilizer', (req, res) => {
  const c = (req.query.crop || '').toLowerCase();
  if (!c) return res.json(Object.keys(FERT));
  if (!FERT[c]) return res.status(404).json({ error: 'No data for this crop' });
  res.json({ crop: c, ...FERT[c] });
});

// ---- seasonal guides ----
const SEASONS = [
  { name: 'Kharif (Monsoon)', period: 'June - October', months: [6, 7, 8, 9, 10],
    crops: ['Rice', 'Maize', 'Cotton', 'Groundnut', 'Red gram (Tur)', 'Soybean', 'Chilli'],
    tips: ['Sow after the monsoon rains are well established.', 'Keep fields well drained to avoid waterlogging.', 'Watch for stem borer, bollworm and fungal diseases in humid weather.', 'Do timely weeding in the first 30-45 days.'] },
  { name: 'Rabi (Winter)', period: 'November - March', months: [11, 12, 1, 2, 3],
    crops: ['Wheat', 'Chickpea', 'Mustard', 'Potato', 'Onion', 'Peas', 'Tomato'],
    tips: ['Sow on time; late sowing cuts yield.', 'Irrigate at critical stages such as crown root and flowering.', 'Protect nurseries from cold and frost.', 'Use certified seed and treat it before sowing.'] },
  { name: 'Zaid (Summer)', period: 'April - May', months: [4, 5],
    crops: ['Watermelon', 'Muskmelon', 'Cucumber', 'Green gram (Moong)', 'Okra', 'Fodder crops'],
    tips: ['Irrigate frequently and mulch to save moisture.', 'Choose short-duration, heat-tolerant varieties.', 'Water in early morning or evening.', 'Sell quickly; summer vegetables spoil fast, so plan transport.'] }
];
app.get('/api/seasons', (req, res) => res.json(SEASONS));

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`AgriConnect running at http://localhost:${PORT}`));
}

module.exports = app;