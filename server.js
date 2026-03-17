const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// ── Africa's Talking SMS ──────────────────────────────────────────────────────
const AT_API_KEY = process.env.AT_API_KEY || "";
const AT_USERNAME = process.env.AT_USERNAME || "sandbox";
const AT_SENDER = process.env.AT_SENDER || "";   // leave empty for shared shortcode

let atSms = null;
if (AT_API_KEY) {
  const AfricasTalking = require("africastalking");
  const at = AfricasTalking({ apiKey: AT_API_KEY, username: AT_USERNAME });
  atSms = at.SMS;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── M-Pesa Daraja API ─────────────────────────────────────────────────────────
const MPESA_KEY = process.env.MPESA_CONSUMER_KEY || "";
const MPESA_SECRET = process.env.MPESA_CONSUMER_SECRET || "";
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || "174379";
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const MPESA_CALLBACK = process.env.MPESA_CALLBACK_URL || "";

async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_KEY}:${MPESA_SECRET}`).toString("base64");
  const url = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const data = await res.json();
  return data.access_token;
}

async function triggerStkPush(phone, amount, orderId) {
  const token = await getMpesaToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString("base64");

  const payload = {
    BusinessShortCode: MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(amount),
    PartyA: phone.replace(/[^0-9]/g, ""),
    PartyB: MPESA_SHORTCODE,
    PhoneNumber: phone.replace(/[^0-9]/g, ""),
    CallBackURL: MPESA_CALLBACK,
    AccountReference: orderId,
    TransactionDesc: `Payment for Order ${orderId}`
  };

  const res = await fetch("https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return res.json();
}
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "127.0.0.1";
const DATA_PATH = path.join(__dirname, "data", "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");

function readStore() {
  const store = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  if (!Array.isArray(store.stockMovements)) store.stockMovements = [];
  if (!store.settings.businessName) store.settings.businessName = "Chewaz Bar and Restaurant";
  if (!store.settings.tillNumber) store.settings.tillNumber = "3706694";
  if (!Array.isArray(store.settings.salesPhones)) {
    store.settings.salesPhones = ["0759305448", "0718236550"];
  }
  store.products = (store.products || []).map((product, index) => ({
    ...product,
    productNumber: Number(product.productNumber || index + 1)
  }));
  return store;
}

function writeStore(store) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getDiscountPercent(product, unit, qty) {
  const matches = (product.bulkDiscounts || [])
    .filter((rule) => rule.unit === unit && qty >= rule.minQty)
    .sort((a, b) => b.percent - a.percent);
  return matches.length ? matches[0].percent : 0;
}

function fulfillBottleQty(product, qty) {
  if (qty <= product.stockBottles) {
    product.stockBottles -= qty;
    return { cratesBroken: 0 };
  }

  if (!product.allowCaseBreak) {
    throw new Error(`Insufficient bottle stock for ${product.name}`);
  }

  const needed = qty - product.stockBottles;
  const cratesToBreak = Math.ceil(needed / product.bottlesPerCrate);

  if (cratesToBreak > product.stockCrates) {
    throw new Error(`Insufficient stock for ${product.name}`);
  }

  product.stockCrates -= cratesToBreak;
  product.stockBottles += cratesToBreak * product.bottlesPerCrate;
  product.stockBottles -= qty;
  return { cratesBroken: cratesToBreak };
}

function buildDailyPricePrompt(store, products, currency) {
  const lines = products.map((p) => `#${p.productNumber} ${p.name} ${p.sizeMl}ml: ${currency} ${p.priceBottle} / bottle`);
  return [
    `${store.settings.businessName} Stock Alert: Today's prices`,
    lines.join("\n"),
    `Till Number: ${store.settings.tillNumber}`,
    `Order: ${store.settings.salesPhones.join(" / ")}`
  ].join("\n");
}

async function sendChannelMessage(channel, phone, message) {
  if (channel === "sms") {
    if (!atSms) {
      // No credentials — return mock so the rest of the flow still works
      console.warn("[SMS] AT_API_KEY not set. Message not sent (mock mode).");
      return { channel, phone, message, status: "mock", provider: "mock" };
    }
    try {
      const opts = { to: [phone], message };
      if (AT_SENDER) opts.from = AT_SENDER;
      const resp = await atSms.send(opts);
      const recipient = resp.SMSMessageData?.Recipients?.[0] || {};
      return {
        channel,
        phone,
        message,
        status: recipient.status || "sent",
        messageId: recipient.messageId || null,
        cost: recipient.cost || null,
        provider: "africastalking"
      };
    } catch (err) {
      console.error("[SMS] Send error:", err.message);
      return { channel, phone, message, status: "error", error: err.message, provider: "africastalking" };
    }
  }

  // WhatsApp — not yet integrated; log and return mock
  console.warn(`[WhatsApp] Provider not configured. Message to ${phone} not sent.`);
  return { channel, phone, message, status: "mock", provider: "mock" };
}

function routeApi(req, res, url) {
  const method = req.method || "GET";
  const store = readStore();

  if (method === "GET" && url.pathname === "/api/settings") {
    return sendJson(res, 200, store.settings);
  }

  if (method === "GET" && url.pathname === "/api/catalog") {
    const category = url.searchParams.get("category");
    const products = store.products
      .filter((p) => p.active && (!category || p.category === category))
      .sort((a, b) => a.productNumber - b.productNumber);
    return sendJson(res, 200, products);
  }

  if (method === "GET" && url.pathname === "/api/catalog/scan") {
    const code = Number(url.searchParams.get("code"));
    if (!code) return sendJson(res, 400, { error: "Scan code is required" });

    const product = store.products.find((p) => p.productNumber === code && p.active);
    if (!product) return sendJson(res, 404, { error: `No active product for code #${code}` });
    return sendJson(res, 200, product);
  }

  if (method === "GET" && url.pathname === "/api/categories") {
    const categories = [...new Set(store.products.filter((p) => p.active).map((p) => p.category))];
    return sendJson(res, 200, categories);
  }

  if (method === "GET" && url.pathname === "/api/inventory") {
    return sendJson(res, 200, store.products
      .slice()
      .sort((a, b) => a.productNumber - b.productNumber)
      .map((p) => ({
        productNumber: p.productNumber,
        id: p.id,
        name: p.name,
        category: p.category,
        stockBottles: p.stockBottles,
        stockCrates: p.stockCrates,
        bottlesPerCrate: p.bottlesPerCrate
      })));
  }

  if (method === "POST" && url.pathname === "/api/inventory/restock") {
    return parseBody(req)
      .then((body) => {
        const product = store.products.find((p) => p.id === body.productId);
        if (!product) return sendJson(res, 404, { error: "Product not found" });

        const addBottles = Number(body.bottles || 0);
        const addCrates = Number(body.crates || 0);
        if (addBottles < 0 || addCrates < 0) return sendJson(res, 400, { error: "Invalid restock quantities" });
        if (addBottles === 0 && addCrates === 0) return sendJson(res, 400, { error: "Restock quantities cannot both be zero" });

        product.stockBottles += addBottles;
        product.stockCrates += addCrates;
        store.stockMovements.unshift({
          id: `stk_${Date.now()}`,
          createdAt: new Date().toISOString(),
          productId: product.id,
          productNumber: product.productNumber,
          productName: product.name,
          type: "stock_in",
          source: "manual_restock",
          bottlesIn: addBottles,
          cratesIn: addCrates,
          bottlesOut: 0,
          cratesOut: 0,
          note: body.note || null
        });
        writeStore(store);

        return sendJson(res, 200, { ok: true, product });
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (method === "POST" && url.pathname === "/api/pricing") {
    return parseBody(req)
      .then((body) => {
        const product = store.products.find((p) => p.id === body.productId);
        if (!product) return sendJson(res, 404, { error: "Product not found" });

        const priceBottle = Number(body.priceBottle);
        const priceCrate = Number(body.priceCrate);
        if (Number.isNaN(priceBottle) || Number.isNaN(priceCrate) || priceBottle <= 0 || priceCrate <= 0) {
          return sendJson(res, 400, { error: "Invalid prices" });
        }

        product.priceBottle = priceBottle;
        product.priceCrate = priceCrate;

        if (Array.isArray(body.bulkDiscounts)) {
          product.bulkDiscounts = body.bulkDiscounts
            .filter((rule) => ["bottle", "crate"].includes(rule.unit))
            .map((rule) => ({
              unit: rule.unit,
              minQty: Number(rule.minQty),
              percent: Number(rule.percent)
            }))
            .filter((rule) => rule.minQty > 0 && rule.percent >= 0 && rule.percent <= 100);
        }

        writeStore(store);
        return sendJson(res, 200, { ok: true, product });
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (method === "POST" && url.pathname === "/api/orders") {
    return parseBody(req)
      .then((body) => {
        if (!body.confirmAge) {
          return sendJson(res, 400, { error: `Customer must confirm ${store.settings.legalAge}+ age gate` });
        }
        if (!body.customer || !body.customer.phone) {
          return sendJson(res, 400, { error: "Customer phone is required" });
        }
        if (!Array.isArray(body.items) || body.items.length === 0) {
          return sendJson(res, 400, { error: "Order items are required" });
        }

        const lines = [];
        let total = 0;

        for (const item of body.items) {
          const qty = Number(item.qty);
          const unit = item.unit;
          if (!["bottle", "crate"].includes(unit) || qty <= 0) {
            return sendJson(res, 400, { error: "Invalid item unit or qty" });
          }

          const product = store.products.find((p) => p.id === item.productId && p.active);
          if (!product) return sendJson(res, 404, { error: `Product not found: ${item.productId}` });

          const unitPrice = unit === "bottle" ? product.priceBottle : product.priceCrate;
          const discountPercent = getDiscountPercent(product, unit, qty);
          const gross = unitPrice * qty;
          const discountAmount = Math.round((gross * discountPercent) / 100);
          const lineTotal = gross - discountAmount;

          if (unit === "bottle") {
            const bottleResult = fulfillBottleQty(product, qty);
            store.stockMovements.unshift({
              id: `stk_${Date.now()}_${product.id}`,
              createdAt: new Date().toISOString(),
              productId: product.id,
              productNumber: product.productNumber,
              productName: product.name,
              type: "stock_out",
              source: "sale_order",
              bottlesIn: 0,
              cratesIn: 0,
              bottlesOut: qty,
              cratesOut: 0,
              cratesBrokenForBottles: bottleResult.cratesBroken,
              note: `Order sale (${unit})`
            });
          } else {
            if (qty > product.stockCrates) {
              return sendJson(res, 400, { error: `Insufficient crate stock for ${product.name}` });
            }
            product.stockCrates -= qty;
            store.stockMovements.unshift({
              id: `stk_${Date.now()}_${product.id}`,
              createdAt: new Date().toISOString(),
              productId: product.id,
              productNumber: product.productNumber,
              productName: product.name,
              type: "stock_out",
              source: "sale_order",
              bottlesIn: 0,
              cratesIn: 0,
              bottlesOut: 0,
              cratesOut: qty,
              cratesBrokenForBottles: 0,
              note: `Order sale (${unit})`
            });
          }

          total += lineTotal;
          lines.push({
            productId: product.id,
            productNumber: product.productNumber,
            name: product.name,
            qty,
            unit,
            unitPrice,
            discountPercent,
            lineTotal
          });
        }

        const order = {
          id: `ord_${Date.now()}`,
          createdAt: new Date().toISOString(),
          customer: {
            name: body.customer.name || "Guest",
            phone: body.customer.phone,
            idNumber: body.customer.idNumber || null,
            verifyOnDelivery: true
          },
          confirmAge: true,
          items: lines,
          total,
          status: "pending_delivery",
          salesContacts: store.settings.salesPhones
        };

        store.orders.unshift(order);
        writeStore(store);
        return sendJson(res, 201, order);
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (method === "GET" && url.pathname === "/api/orders") {
    return sendJson(res, 200, store.orders);
  }

  if (method === "POST" && url.pathname === "/api/marketing/broadcast") {
    return parseBody(req)
      .then(async (body) => {
        const channel = body.channel;
        if (!["sms", "whatsapp"].includes(channel)) {
          return sendJson(res, 400, { error: "Channel must be sms or whatsapp" });
        }

        const productIds = Array.isArray(body.productIds) ? body.productIds : [];
        const focusProducts = productIds.length
          ? store.products.filter((p) => productIds.includes(p.id))
          : store.products.filter((p) => p.active);

        const rawMessage = body.message && String(body.message).trim().length
          ? String(body.message).trim()
          : buildDailyPricePrompt(store, focusProducts, store.settings.currency);
        const salesLine = `Order: ${store.settings.salesPhones.join(" / ")}`;
        const message = rawMessage.includes("Order:") ? rawMessage : `${rawMessage}\n${salesLine}`;

        const recipients = store.customers.filter((c) => c.channels && c.channels[channel] && c.phone);
        const results = await Promise.all(
          recipients.map((recipient) => sendChannelMessage(channel, recipient.phone, message))
        );

        const log = {
          id: `mkt_${Date.now()}`,
          createdAt: new Date().toISOString(),
          channel,
          recipients: recipients.length,
          message,
          resultPreview: results.slice(0, 5)
        };

        store.marketingLogs.unshift(log);
        writeStore(store);

        const provider = atSms ? "africastalking" : "mock";
        return sendJson(res, 200, {
          ok: true,
          queued: results.length,
          channel,
          message,
          provider,
          results
        });
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (method === "GET" && url.pathname === "/api/marketing/logs") {
    return sendJson(res, 200, store.marketingLogs);
  }

  if (method === "POST" && url.pathname === "/api/payments/stkpush") {
    return parseBody(req)
      .then(async (body) => {
        const { phone, amount, orderId } = body;
        if (!phone || !amount || !orderId) {
          return sendJson(res, 400, { error: "Phone, amount, and orderId are required" });
        }
        try {
          const result = await triggerStkPush(phone, amount, orderId);

          if (result.ResponseCode === "0") {
            const order = store.orders.find(o => o.id === orderId);
            if (order) {
              order.mpesaCheckoutRequestId = result.CheckoutRequestID;
              writeStore(store);
            }
          }

          return sendJson(res, 200, result);
        } catch (err) {
          console.error("[M-Pesa] STK Push error:", err.message);
          return sendJson(res, 500, { error: err.message });
        }
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (method === "POST" && url.pathname === "/api/payments/callback") {
    return parseBody(req)
      .then((body) => {
        const stkCallback = body.Body.stkCallback;
        const checkoutRequestId = stkCallback.CheckoutRequestID;
        const status = stkCallback.ResultCode === 0 ? "paid" : "failed";

        console.log(`[M-Pesa] Payment callback for CheckoutID ${checkoutRequestId}: ${status}`);

        // Find order and update status
        const order = store.orders.find(o => o.mpesaCheckoutRequestId === checkoutRequestId);
        if (order) {
          order.paymentStatus = status;
          order.mpesaResult = stkCallback;
          writeStore(store);
          console.log(`[M-Pesa] Order ${order.id} marked as ${status}`);
        }

        return sendJson(res, 200, { ok: true });
      })
      .catch((err) => {
        console.error("[M-Pesa] Callback error:", err.message);
        return sendJson(res, 400, { error: err.message });
      });
  }

  if (method === "GET" && url.pathname === "/api/stock/movements") {
    return sendJson(res, 200, store.stockMovements.slice(0, 250));
  }

  return sendJson(res, 404, { error: "Not found" });
}

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function serveStatic(req, res, url) {
  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeByExt[ext] || "application/octet-stream";
  const content = fs.readFileSync(filePath);

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length
  });
  res.end(content);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if ((req.method === "POST" || req.method === "PUT" || req.method === "PATCH") && req.headers["content-type"]?.includes("application/json") === false) {
    return sendJson(res, 415, { error: "Content-Type must be application/json" });
  }

  if (url.pathname.startsWith("/api/")) {
    return routeApi(req, res, url);
  }

  return serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Raven Store running at http://${HOST}:${PORT}`);
});
