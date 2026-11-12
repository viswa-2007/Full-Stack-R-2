let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
let trends = [];

const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, method = 'GET', body) {
  const r = await fetch('/api/' + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}

// ---------- auth ----------
async function register() {
  try {
    await api('register', 'POST', {
      name: $('#a-name').value, email: $('#a-email').value,
      password: $('#a-pass').value, role: $('#a-role').value
    });
    $('#a-msg').style.color = '#2e7d32';
    $('#a-msg').textContent = 'Registered! Now click Login.';
  } catch (e) { $('#a-msg').style.color = '#c62828'; $('#a-msg').textContent = e.message; }
}

async function login() {
  try {
    const d = await api('login', 'POST', { email: $('#a-email').value, password: $('#a-pass').value });
    token = d.token; user = d.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    refresh();
  } catch (e) { $('#a-msg').style.color = '#c62828'; $('#a-msg').textContent = e.message; }
}

function logout() {
  localStorage.clear(); token = null; user = null; refresh();
}

// ---------- page refresh ----------
async function refresh() {
  $('#nav').innerHTML = user
    ? `<span>${esc(user.name)} (${user.role})</span><button class="small alt" onclick="logout()">Logout</button>`
    : '';
  $('#auth').classList.toggle('hidden', !!user);
  $('#farmer').classList.toggle('hidden', !(user && user.role === 'farmer'));
  $('#buyer').classList.toggle('hidden', !(user && user.role === 'buyer'));
  await loadTrends();
  await loadProducts();
  if (user) {
    try { await loadOrders(); } catch (e) { logout(); }
  }
}

// ---------- market trends ----------
async function loadTrends() {
  trends = await api('trends');
  $('#trends').innerHTML = trends.length
    ? trends.map(t => `<div class="item"><h3>${esc(t.name)}</h3>
        <div class="price">Avg ₹${t.avg}/kg</div>
        <small>Range ₹${t.min} - ₹${t.max} · ${t.listings} listing(s)</small></div>`).join('')
    : '<p>No market data yet. Farmers can start listing products.</p>';
}

// fair-price hint for farmers while typing
function hint() {
  const t = trends.find(x => x.name === $('#p-name').value.trim().toLowerCase());
  $('#p-hint').textContent = t ? `Market average for ${t.name}: ₹${t.avg}/kg (₹${t.min} - ₹${t.max})` : '';
}

// ---------- products ----------
async function loadProducts() {
  const list = await api('products?q=' + encodeURIComponent($('#search').value));
  const isBuyer = user && user.role === 'buyer';
  $('#products').innerHTML = list.filter(p => p.quantity > 0).map(p => `
    <div class="item">
      <h3>${esc(p.name)}</h3>
      <div class="price">₹${p.price}/kg</div>
      <div>${esc(p.category)} · ${p.quantity} kg available</div>
      <small>Farmer: ${esc(p.farmerName)} · ${esc(p.location)}</small>
      ${isBuyer ? `<div class="buy"><input id="q-${p.id}" type="number" min="1" placeholder="kg">
        <button class="small" onclick="order('${p.id}')">Order</button></div>` : ''}
    </div>`).join('') || '<p>No products found.</p>';

  if (user && user.role === 'farmer') {
    const mine = list.filter(p => p.farmerId === user.id);
    $('#my-products').innerHTML = mine.length
      ? `<table><tr><th>Product</th><th>Price/kg</th><th>Stock (kg)</th><th></th></tr>` +
        mine.map(p => `<tr><td>${esc(p.name)}</td><td>₹${p.price}</td><td>${p.quantity}</td>
          <td><button class="small danger" onclick="delProduct('${p.id}')">Delete</button></td></tr>`).join('') + '</table>'
      : '<p>You have not listed any products yet.</p>';
  }
}

async function addProduct() {
  try {
    await api('products', 'POST', {
      name: $('#p-name').value, category: $('#p-cat').value, price: $('#p-price').value,
      quantity: $('#p-qty').value, location: $('#p-loc').value
    });
    ['#p-name', '#p-price', '#p-qty', '#p-loc'].forEach(s => $(s).value = '');
    $('#p-hint').textContent = '';
    refresh();
  } catch (e) { alert(e.message); }
}

async function delProduct(id) {
  if (confirm('Delete this product?')) { await api('products/' + id, 'DELETE'); refresh(); }
}

// ---------- orders ----------
async function order(productId) {
  try {
    await api('orders', 'POST', { productId, quantity: $('#q-' + productId).value });
    alert('Order placed successfully!');
    refresh();
  } catch (e) { alert(e.message); }
}

async function loadOrders() {
  const orders = await api('orders');
  if (user.role === 'farmer') {
    const total = orders.reduce((s, o) => s + o.total, 0);
    $('#sales').textContent = `Total sales value: ₹${total.toFixed(2)} (${orders.length} orders)`;
    $('#f-orders').innerHTML = orders.length
      ? `<table><tr><th>Date</th><th>Buyer</th><th>Product</th><th>Qty</th><th>Total</th><th>Status</th></tr>` +
        orders.map(o => `<tr><td>${new Date(o.date).toLocaleDateString()}</td><td>${esc(o.buyerName)}</td>
          <td>${esc(o.productName)}</td><td>${o.quantity} kg</td><td>₹${o.total}</td>
          <td>${o.status === 'Pending' ? `<button class="small" onclick="deliver('${o.id}')">Mark Delivered</button>` : o.status}</td></tr>`).join('') + '</table>'
      : '<p>No orders yet.</p>';
  } else {
    $('#b-orders').innerHTML = orders.length
      ? `<table><tr><th>Date</th><th>Product</th><th>Qty</th><th>Total</th><th>Status</th></tr>` +
        orders.map(o => `<tr><td>${new Date(o.date).toLocaleDateString()}</td><td>${esc(o.productName)}</td>
          <td>${o.quantity} kg</td><td>₹${o.total}</td><td>${o.status}</td></tr>`).join('') + '</table>'
      : '<p>You have not placed any orders yet.</p>';
  }
}

async function deliver(id) { await api('orders/' + id, 'PATCH'); refresh(); }

// ---------- fertilizer suggestions & seasonal guides ----------
async function loadTools() {
  const crops = await api('fertilizer');
  $('#f-crop').innerHTML = crops.map(c => `<option value="${c}">${c[0].toUpperCase() + c.slice(1)}</option>`).join('');

  const seasons = await api('seasons');
  const month = new Date().getMonth() + 1;
  $('#seasons').innerHTML = seasons.map(s => {
    const now = s.months.includes(month);
    return `<div class="item ${now ? 'now' : ''}">
      <h3>${esc(s.name)} ${now ? '<span class="badge">Now</span>' : ''}</h3>
      <small>${esc(s.period)}</small>
      <p><b>Crops:</b> ${esc(s.crops.join(', '))}</p>
      <ul>${s.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
  }).join('');
}

async function getFert() {
  try {
    const f = await api('fertilizer?crop=' + $('#f-crop').value);
    const a = Number($('#f-acres').value) || 1;
    // DAP = 18% N, 46% P2O5 | Urea = 46% N | MOP = 60% K2O
    const dap = f.p / 0.46;
    const urea = Math.max(0, f.n - dap * 0.18) / 0.46;
    const mop = f.k / 0.6;
    const r = (x) => (x * a).toFixed(1);
    $('#f-result').innerHTML = `
      <p><b>Nutrient need:</b> N ${f.n} - P ${f.p} - K ${f.k} kg per acre</p>
      <table><tr><th>Fertilizer</th><th>Quantity for ${a} acre(s)</th></tr>
        <tr><td>Urea</td><td>${r(urea)} kg</td></tr>
        <tr><td>DAP</td><td>${r(dap)} kg</td></tr>
        <tr><td>MOP (Potash)</td><td>${r(mop)} kg</td></tr></table>
      <p><b>When to apply:</b> ${esc(f.timing)}</p>
      <p><b>Organic option:</b> ${esc(f.organic)}</p>
      <p><b>Tip:</b> ${esc(f.tip)}</p>
      <p class="hint">These are general estimates. Get a soil test or ask your local agriculture office before applying.</p>`;
  } catch (e) { alert(e.message); }
}

refresh();
loadTools();