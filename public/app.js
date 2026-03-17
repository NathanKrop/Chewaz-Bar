const state = {
  settings: null,
  categories: [],
  products: [],
  visibleProducts: [],
  inventory: [],
  stockMovements: [],
  cart: []
};

const $ = (sel) => document.querySelector(sel);

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function currency(value) {
  const curr = state.settings?.currency || "KES";
  return `${curr} ${value}`;
}

function totalBottleEquivalent(product) {
  return product.stockBottles + product.stockCrates * product.bottlesPerCrate;
}

function getStockStatus(product) {
  const equivalent = totalBottleEquivalent(product);
  if (equivalent <= 0) {
    return { label: "Out of stock", className: "stock-out", rank: 0 };
  }
  if (equivalent <= product.bottlesPerCrate) {
    return { label: "Low stock", className: "stock-low", rank: 1 };
  }
  return { label: "In stock", className: "stock-in", rank: 2 };
}

function addToCart(productId, unit, qty) {
  const parsedQty = Number(qty);
  if (!parsedQty || parsedQty <= 0) return;

  const existing = state.cart.find((c) => c.productId === productId && c.unit === unit);
  if (existing) {
    existing.qty += parsedQty;
  } else {
    state.cart.push({ productId, unit, qty: parsedQty });
  }
  renderCart();
}

function renderCart() {
  const box = $("#cart");
  if (!state.cart.length) {
    box.innerHTML = "<p>Cart is empty.</p>";
    return;
  }

  box.innerHTML = state.cart
    .map((item, idx) => {
      const product = state.products.find((p) => p.id === item.productId);
      return `
        <div class="product">
          <strong>${product?.name || item.productId}</strong><br>
          ${item.qty} x ${item.unit}
          <button data-cart-rm="${idx}">Remove</button>
        </div>
      `;
    })
    .join("");

  box.querySelectorAll("[data-cart-rm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.cart.splice(Number(btn.getAttribute("data-cart-rm")), 1);
      renderCart();
    });
  });
}

function applyCatalogFilters() {
  const selectedCategory = $("#categoryFilter").value;
  const search = $("#catalogSearch").value.trim().toLowerCase();
  const sort = $("#sortFilter").value;

  let filtered = state.products.filter((product) => {
    if (selectedCategory && selectedCategory !== "All" && product.category !== selectedCategory) return false;
    if (!search) return true;

    const haystack = [
      String(product.productNumber || ""),
      product.name,
      product.brand,
      product.category,
      String(product.sizeMl || "")
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(search);
  });

  filtered = filtered.sort((a, b) => {
    if (sort === "price_asc") return a.priceBottle - b.priceBottle;
    if (sort === "price_desc") return b.priceBottle - a.priceBottle;
    if (sort === "name_asc") return a.name.localeCompare(b.name);
    if (sort === "stock_desc") return totalBottleEquivalent(b) - totalBottleEquivalent(a);
    return a.productNumber - b.productNumber;
  });

  state.visibleProducts = filtered;
  renderCatalog();
}

function renderCatalog() {
  const catalog = $("#catalog");

  if (!state.visibleProducts.length) {
    catalog.innerHTML = "<p>No products match your filters.</p>";
    return;
  }

  catalog.innerHTML = state.visibleProducts
    .map((p) => {
      const stockStatus = getStockStatus(p);
      return `
        <article class="product">
          <h4>#${p.productNumber} ${p.name}</h4>
          <div class="meta">${p.category} | ${p.sizeMl}ml | ${p.brand}</div>
          <div class="meta">Bottle: ${currency(p.priceBottle)} | Crate: ${currency(p.priceCrate)}</div>
          <div class="meta stock-line"><span class="stock-badge ${stockStatus.className}">${stockStatus.label}</span>Stock: ${p.stockBottles} bottles, ${p.stockCrates} crates</div>
          <div class="row">
            <select data-unit="${p.id}">
              <option value="bottle">Bottle</option>
              <option value="crate">Crate</option>
            </select>
            <input type="number" min="1" value="1" data-qty="${p.id}" />
            <button data-add="${p.id}">Add</button>
          </div>
        </article>
      `;
    })
    .join("");

  catalog.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-add");
      const unit = catalog.querySelector(`[data-unit='${id}']`).value;
      const qty = catalog.querySelector(`[data-qty='${id}']`).value;
      addToCart(id, unit, qty);
    });
  });
}

function buildTopSellerRows() {
  const salesByProduct = new Map();

  state.stockMovements
    .filter((m) => m.type === "stock_out" && m.source === "sale_order")
    .forEach((movement) => {
      const product = state.products.find((p) => p.id === movement.productId);
      if (!product) return;
      const soldEquivalent = Number(movement.bottlesOut || 0) + Number(movement.cratesOut || 0) * product.bottlesPerCrate;
      if (!soldEquivalent) return;

      const existing = salesByProduct.get(product.id) || { product, soldEquivalent: 0 };
      existing.soldEquivalent += soldEquivalent;
      salesByProduct.set(product.id, existing);
    });

  const sorted = [...salesByProduct.values()].sort((a, b) => b.soldEquivalent - a.soldEquivalent);
  if (sorted.length) return sorted.slice(0, 6);

  return state.products
    .slice()
    .sort((a, b) => a.productNumber - b.productNumber)
    .slice(0, 6)
    .map((product) => ({ product, soldEquivalent: null }));
}

function renderTopSellers() {
  const box = $("#topSellers");
  if (!box) return;

  const rows = buildTopSellerRows();
  if (!rows.length) {
    box.innerHTML = "<p>No top seller data yet.</p>";
    return;
  }

  box.innerHTML = rows
    .map(({ product, soldEquivalent }) => {
      const stockStatus = getStockStatus(product);
      const soldLabel = soldEquivalent == null ? "No sales history yet" : `Sold: ${soldEquivalent} bottle-eq`;
      return `
        <article class="top-seller">
          <h4>#${product.productNumber} ${product.name}</h4>
          <div class="meta">${product.brand} | ${product.sizeMl}ml</div>
          <div class="meta">Bottle: ${currency(product.priceBottle)}</div>
          <div class="meta stock-line"><span class="stock-badge ${stockStatus.className}">${stockStatus.label}</span>${soldLabel}</div>
        </article>
      `;
    })
    .join("");
}

function renderInventory() {
  const table = `
    <table class="table">
      <thead>
        <tr><th>No.</th><th>Product</th><th>Category</th><th>Bottles</th><th>Crates</th><th>Bottles/Crate</th></tr>
      </thead>
      <tbody>
        ${state.inventory
      .map(
        (row) =>
          `<tr><td>${row.productNumber}</td><td>${row.name}</td><td>${row.category}</td><td>${row.stockBottles}</td><td>${row.stockCrates}</td><td>${row.bottlesPerCrate}</td></tr>`
      )
      .join("")}
      </tbody>
    </table>
  `;
  $("#inventoryTable").innerHTML = table;
}

function renderStockMovements() {
  const rows = state.stockMovements
    .slice(0, 30)
    .map((m) => `
      <tr>
        <td>${new Date(m.createdAt).toLocaleString()}</td>
        <td>#${m.productNumber} ${m.productName}</td>
        <td>${m.type}</td>
        <td>${m.bottlesIn}</td>
        <td>${m.cratesIn}</td>
        <td>${m.bottlesOut}</td>
        <td>${m.cratesOut}</td>
      </tr>
    `)
    .join("");

  $("#stockMovementTable").innerHTML = `
    <table class="table">
      <thead>
        <tr><th>Time</th><th>Product</th><th>Type</th><th>Bottles In</th><th>Crates In</th><th>Bottles Out</th><th>Crates Out</th></tr>
      </thead>
      <tbody>${rows || "<tr><td colspan='7'>No movement yet.</td></tr>"}</tbody>
    </table>
  `;
}

async function loadCatalog(forceReload = false) {
  if (forceReload || !state.products.length) {
    state.products = await api("/api/catalog");
  }
  applyCatalogFilters();
  renderTopSellers();
}

async function loadBasics() {
  const [settings, categories, inventory, stockMovements] = await Promise.all([
    api("/api/settings"),
    api("/api/categories"),
    api("/api/inventory"),
    api("/api/stock/movements")
  ]);

  state.settings = settings;
  state.categories = categories;
  state.inventory = inventory;
  state.stockMovements = stockMovements;

  $("#businessName").textContent = settings.businessName;
  $("#businessMeta").textContent = `Till Number: ${settings.tillNumber}`;
  $("#salesPhones").textContent = `Sales: ${settings.salesPhones.join(" / ")}`;
  $("#deliveryHours").textContent = `Delivery: ${settings.deliveryHours}`;

  const categoryOptions = ["All", ...categories].map((c) => `<option value="${c}">${c}</option>`).join("");
  $("#categoryFilter").innerHTML = categoryOptions;

  const productOptions = inventory.map((p) => `<option value="${p.id}">#${p.productNumber} ${p.name}</option>`).join("");
  $("#restockProduct").innerHTML = productOptions;
  $("#priceProduct").innerHTML = productOptions;

  renderInventory();
  renderStockMovements();
}

async function onCheckout(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);

  const payload = {
    customer: {
      name: form.get("name"),
      phone: form.get("phone"),
      idNumber: form.get("idNumber")
    },
    confirmAge: Boolean(form.get("confirmAge")),
    items: state.cart
  };

  try {
    const order = await api("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const paymentMethod = form.get("paymentMethod");
    let statusText = `Order ${order.id} created. Total: ${currency(order.total)}.`;

    if (paymentMethod === "mpesa") {
      statusText += " Initializing M-Pesa payment prompt...";
      $("#checkoutStatus").textContent = statusText;

      try {
        const mpesaResult = await api("/api/payments/stkpush", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: payload.customer.phone,
            amount: order.total,
            orderId: order.id
          })
        });

        if (mpesaResult.ResponseCode === "0") {
          statusText = `Order ${order.id} created. Please check your phone for the M-Pesa PIN prompt to pay ${currency(order.total)}.`;
        } else {
          statusText = `Order ${order.id} created, but M-Pesa prompt failed: ${mpesaResult.ResponseDescription || "Unknown error"}. Please pay via cash on delivery.`;
        }
      } catch (err) {
        statusText = `Order ${order.id} created, but M-Pesa prompt failed: ${err.message}. Please pay via cash on delivery.`;
      }
    } else {
      statusText += ` Please pay ${currency(order.total)} via cash on delivery.`;
    }

    $("#checkoutStatus").textContent = statusText;
    state.cart = [];
    renderCart();
    await refreshData();
  } catch (err) {
    $("#checkoutStatus").textContent = err.message;
  }
}

async function onRestock(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    await api("/api/inventory/restock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: form.get("productId"),
        bottles: Number(form.get("bottles")),
        crates: Number(form.get("crates"))
      })
    });
    await refreshData();
  } catch (err) {
    alert(err.message);
  }
}

async function onPricing(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    await api("/api/pricing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: form.get("productId"),
        priceBottle: Number(form.get("priceBottle")),
        priceCrate: Number(form.get("priceCrate"))
      })
    });
    await refreshData();
  } catch (err) {
    alert(err.message);
  }
}

async function onMarketing(ev) {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    const result = await api("/api/marketing/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: form.get("channel"),
        message: form.get("message"),
        salesPhones: state.settings.salesPhones
      })
    });
    $("#marketingStatus").textContent = `Queued ${result.queued} ${result.channel} prompts via ${result.provider}`;
  } catch (err) {
    $("#marketingStatus").textContent = err.message;
  }
}

async function refreshData() {
  const [inventory, stockMovements] = await Promise.all([
    api("/api/inventory"),
    api("/api/stock/movements")
  ]);

  state.inventory = inventory;
  state.stockMovements = stockMovements;

  renderInventory();
  renderStockMovements();

  await loadCatalog(true);
}

async function onScanAdd() {
  const code = Number($("#scanCode").value);
  const unit = $("#scanUnit").value;
  const qty = Number($("#scanQty").value || 1);

  if (!code || qty <= 0) return;

  try {
    const product = await api(`/api/catalog/scan?code=${code}`);
    addToCart(product.id, unit, qty);
    $("#scanCode").value = "";
  } catch (err) {
    alert(err.message);
  }
}

function initAgeGate() {
  const accepted = localStorage.getItem("raven_age_ok") === "1";
  const gate = $("#ageGate");

  if (accepted) gate.classList.add("hidden");

  $("#ageConfirmBtn").addEventListener("click", () => {
    localStorage.setItem("raven_age_ok", "1");
    gate.classList.add("hidden");
  });
}

async function main() {
  initAgeGate();
  await loadBasics();
  await loadCatalog(true);
  renderCart();

  $("#reloadCatalog").addEventListener("click", () => loadCatalog(true));
  $("#categoryFilter").addEventListener("change", applyCatalogFilters);
  $("#catalogSearch").addEventListener("input", applyCatalogFilters);
  $("#sortFilter").addEventListener("change", applyCatalogFilters);
  $("#checkoutForm").addEventListener("submit", onCheckout);
  $("#restockForm").addEventListener("submit", onRestock);
  $("#pricingForm").addEventListener("submit", onPricing);
  $("#marketingForm").addEventListener("submit", onMarketing);
  $("#scanAddBtn").addEventListener("click", onScanAdd);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  alert(err.message);
});
