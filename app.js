// Import dependencies
const express = require("express");
const path = require("path");
const multer = require("multer");          // for file uploads
const xlsx = require("xlsx");              // for reading Excel
require("dotenv").config();

// Create Express app
const app = express();
app.use(express.json());

// File upload (Excel) config – keep files in memory
const upload = multer({ storage: multer.memoryStorage() });

// PORT + VERIFY TOKEN
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN || "vibecode";

// ---------------------------------------------
// 🔹 In-memory storage (no MongoDB)
// ---------------------------------------------
/*
  contactsMap: {
    "919490140810": { waNumber: "919490140810", name: null, lastMessageAt: Date }
  }

  messages: [
    {
      waNumber, direction, message_id, from, to,
      timestamp, type, text, raw
    }
  ]
*/
const contactsMap = new Map();
const messages = [];

// Helper to upsert contact
function upsertContact(waNumber, tsSec) {
  const lastMessageAt =
    tsSec && !isNaN(tsSec) ? new Date(parseInt(tsSec) * 1000) : new Date();

  const existing = contactsMap.get(waNumber) || {
    waNumber,
    name: null,
    lastMessageAt,
  };
  existing.lastMessageAt = lastMessageAt;
  contactsMap.set(waNumber, existing);
  return existing;
}

// ---------------------------------------------
// 📦 Helpers for WhatsApp Cloud API
// ---------------------------------------------

// Get config or throw if missing
function getWAConfig(requireWaba = false) {
  const phoneId = process.env.WA_PHONE_ID;  // number ID
  const token = process.env.WA_TOKEN;       // access token
  const wabaId = process.env.WA_WABA_ID;    // WhatsApp Business Account ID

  if (!phoneId || !token) {
    throw new Error("WA_PHONE_ID or WA_TOKEN not set in environment");
  }
  if (requireWaba && !wabaId) {
    throw new Error("WA_WABA_ID (WhatsApp Business Account ID) not set");
  }

  return { phoneId, token, wabaId };
}

// Send plain text message
async function sendTextMessage(waNumber, text) {
  const { phoneId, token } = getWAConfig(false);

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: waNumber,
    type: "text",
    text: { body: text },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  console.log("📤 Text send response:", data);

  if (!response.ok) {
    throw new Error(`WhatsApp text send failed: ${JSON.stringify(data)}`);
  }

  return data;
}

// Send template message
async function sendTemplateMessage(waNumber, templateName, languageCode, bodyParams) {
  const { phoneId, token } = getWAConfig(false);

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

  const components = [];
  if (Array.isArray(bodyParams) && bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParams.map((p) => ({
        type: "text",
        text: String(p),
      })),
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    to: waNumber,
    type: "template",
    template: {
      name: templateName,             // e.g. "welcome_fx_client"
      language: { code: languageCode || "en" }, // e.g. "en" / "en_US"
      components,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  console.log("📤 Template send response:", data);

  if (!response.ok) {
    throw new Error(`WhatsApp template send failed: ${JSON.stringify(data)}`);
  }

  return data;
}

// ---------------------------------------------
// 🔥 GET Route → META VERIFICATION
// ---------------------------------------------
app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("Verification request:", { mode, token, challenge });

  if (mode === "subscribe" && token === verifyToken) {
    console.log("✅ WEBHOOK VERIFIED");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Verification failed");
    res.status(403).send("Verification failed");
  }
});

// ---------------------------------------------
// 🔥 POST Route → Webhook Messages
// ---------------------------------------------
app.post("/", async (req, res) => {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n📩 Webhook received at ${ts}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) {
      return res.sendStatus(200);
    }

    // 1) Incoming user messages
    if (value.messages && !value.statuses) {
      const msg = value.messages[0];

      const from = msg.from; // user number
      const to = value.metadata?.display_phone_number || "";
      const text = msg.text?.body || "";

      const contact = upsertContact(from, msg.timestamp);

      messages.push({
        waNumber: from,
        direction: "in",
        message_id: msg.id,
        from,
        to,
        timestamp: msg.timestamp,
        type: msg.type,
        text,
        raw: req.body,
      });

      console.log("👤 Incoming from", from, ":", text);
      console.log("💾 Message saved (in-memory) for contact:", contact.waNumber);
    }

    // 2) Status updates (delivered, read, etc.)
    if (value.statuses) {
      const status = value.statuses[0];
      console.log(
        "📦 Status update:",
        status.status,
        "for",
        status.recipient_id
      );
    }
  } catch (err) {
    console.log("❌ Error handling webhook:", err);
  }

  res.sendStatus(200);
});

// ---------------------------------------------
// 🌐 API: List contacts (in-memory)
// ---------------------------------------------
app.get("/api/contacts", (req, res) => {
  try {
    const contacts = Array.from(contactsMap.values()).sort(
      (a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt)
    );
    res.json(contacts);
  } catch (err) {
    console.error("Error fetching contacts:", err);
    res.status(500).json({ error: "failed_to_fetch_contacts" });
  }
});

// 🌐 API: Get messages for one contact (in-memory)
app.get("/api/messages", (req, res) => {
  const waNumber = req.query.waNumber;
  if (!waNumber) {
    return res.status(400).json({ error: "waNumber is required" });
  }

  try {
    const msgs = messages
      .filter((m) => m.waNumber === waNumber)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    res.json(msgs);
  } catch (err) {
    console.error("Error fetching messages:", err);
    res.status(500).json({ error: "failed_to_fetch_messages" });
  }
});

// ---------------------------------------------
// 🌐 API: Send outbound text (single)
// ---------------------------------------------
app.post("/api/send", async (req, res) => {
  const { waNumber, text } = req.body;

  if (!waNumber || !text) {
    return res.status(400).json({ error: "waNumber and text are required" });
  }

  try {
    const data = await sendTextMessage(waNumber, text);

    const nowSec = Math.floor(Date.now() / 1000);
    upsertContact(waNumber, nowSec);

    messages.push({
      waNumber,
      direction: "out",
      message_id: data.messages?.[0]?.id || "",
      from: "",
      to: waNumber,
      timestamp: String(nowSec),
      type: "text",
      text,
      raw: data,
    });

    res.json({ ok: true, data });
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ error: "send_failed", details: err.message });
  }
});

// ---------------------------------------------
// 🌐 API: Broadcast plain text to many numbers
// body: { waNumbers: [ "91...", "91..." ], text: "message" }
// ---------------------------------------------
app.post("/api/broadcast", async (req, res) => {
  const { waNumbers, text } = req.body;

  if (!Array.isArray(waNumbers) || waNumbers.length === 0 || !text) {
    return res
      .status(400)
      .json({ error: "waNumbers (array) and text are required" });
  }

  const results = [];

  for (const num of waNumbers) {
    const waNumber = String(num).replace(/[^0-9]/g, "");
    if (!waNumber) continue;

    try {
      const data = await sendTextMessage(waNumber, text);

      const nowSec = Math.floor(Date.now() / 1000);
      upsertContact(waNumber, nowSec);

      messages.push({
        waNumber,
        direction: "out",
        message_id: data.messages?.[0]?.id || "",
        from: "",
        to: waNumber,
        timestamp: String(nowSec),
        type: "text",
        text,
        raw: data,
      });

      results.push({ waNumber, ok: true });
    } catch (err) {
      console.error("Broadcast error for", waNumber, err.message);
      results.push({ waNumber, ok: false, error: err.message });
    }
  }

  res.json({ ok: true, results });
});

// ---------------------------------------------
// 🌐 API: Send template message (single)
// body: { waNumber, templateName, languageCode, bodyParams: [] }
// ---------------------------------------------
app.post("/api/send-template", async (req, res) => {
  const { waNumber, templateName, languageCode, bodyParams } = req.body;

  if (!waNumber || !templateName) {
    return res
      .status(400)
      .json({ error: "waNumber and templateName are required" });
  }

  try {
    const data = await sendTemplateMessage(
      waNumber,
      templateName,
      languageCode || "en",
      bodyParams || []
    );

    const nowSec = Math.floor(Date.now() / 1000);
    upsertContact(waNumber, nowSec);

    messages.push({
      waNumber,
      direction: "out",
      message_id: data.messages?.[0]?.id || "",
      from: "",
      to: waNumber,
      timestamp: String(nowSec),
      type: "template",
      text: `[TEMPLATE] ${templateName}`,
      raw: data,
    });

    res.json({ ok: true, data });
  } catch (err) {
    console.error("Error sending template:", err);
    res.status(500).json({ error: "template_send_failed", details: err.message });
  }
});

// ---------------------------------------------
// 🌐 API: Create template in WhatsApp (for approval)
// body: { name, category, languageCode, bodyText }
// category example: "MARKETING" | "UTILITY" | "AUTHENTICATION"
// ---------------------------------------------
app.post("/api/templates", async (req, res) => {
  const { name, category, languageCode, bodyText } = req.body;

  if (!name || !category || !bodyText) {
    return res.status(400).json({
      error: "name, category and bodyText are required",
    });
  }

  try {
    const { wabaId, token } = getWAConfig(true);

    const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates`;

    const payload = {
      name,                    // lowercase, no spaces: "welcome_fx_client"
      category,                // "MARKETING", "UTILITY", etc.
      language: languageCode || "en",
      components: [
        {
          type: "BODY",
          text: bodyText,      // "Hi {{1}}, welcome to LakshmiFX..."
        },
      ],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    console.log("📄 Template create response:", data);

    if (!response.ok) {
      throw new Error(JSON.stringify(data));
    }

    res.json({ ok: true, data });
  } catch (err) {
    console.error("Error creating template:", err);
    res
      .status(500)
      .json({ error: "template_create_failed", details: err.message });
  }
});

// 🌐 API: List templates from WhatsApp
app.get("/api/templates", async (req, res) => {
  try {
    const { wabaId, token } = getWAConfig(true);

    const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await response.json();
    console.log("📄 Template list response:", data);

    if (!response.ok) {
      throw new Error(JSON.stringify(data));
    }

    res.json({ ok: true, data });
  } catch (err) {
    console.error("Error listing templates:", err);
    res
      .status(500)
      .json({ error: "template_list_failed", details: err.message });
  }
});

// ---------------------------------------------
// 🌐 API: Upload Excel of numbers
// expects form-data with field name "file"
// returns { count, numbers: ["91...", ...] }
// ---------------------------------------------
app.post("/api/upload-excel", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "file is required" });
    }

    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    const nums = new Set();

    for (const row of rows) {
      if (!row || row.length === 0) continue;
      const cell = row[0];
      if (!cell) continue;

      const cleaned = String(cell).replace(/[^0-9]/g, "");
      if (cleaned) nums.add(cleaned);
    }

    const numbers = Array.from(nums);
    res.json({ ok: true, count: numbers.length, numbers });
  } catch (err) {
    console.error("Error reading Excel:", err);
    res.status(500).json({ error: "excel_parse_failed", details: err.message });
  }
});

// ---------------------------------------------
// 🖥 Serve Inbox UI
// ---------------------------------------------
app.get("/inbox", (req, res) => {
  res.sendFile(path.join(__dirname, "inbox.html"));
});

// ---------------------------------------------
// 🚀 Start Server
// ---------------------------------------------
app.listen(port, () => {
  console.log(`\n🚀 Server running on port ${port}\n`);
});
