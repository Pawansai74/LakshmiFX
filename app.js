// app.js

// -------------------------
// Imports & basic setup
// -------------------------
const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

// Port & verify token (for Meta webhook)
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN || "vibecode";

// -------------------------
// In-memory storage
// -------------------------
/*
  contactsMap: {
    "919490140810": { waNumber, name, lastMessageAt: Date }
  }

  messages: [
    {
      waNumber,        // contact number
      direction,       // "in" | "out"
      message_id,
      from,
      to,
      timestamp,       // WhatsApp unix seconds
      type,
      text,
      raw              // full payload / response
    }
  ]

  templates: [
    { id, name, body, category }
  ]
*/
const contactsMap = new Map();
const messages = [];
const templates = [];

// -------------------------
// Helper: upsert contact
// -------------------------
function upsertContact(waNumber, tsSec) {
  const lastMessageAt =
    tsSec && !isNaN(tsSec) ? new Date(parseInt(tsSec) * 1000) : new Date();

  const existing =
    contactsMap.get(waNumber) || {
      waNumber,
      name: null,
      lastMessageAt,
    };

  existing.lastMessageAt = lastMessageAt;
  contactsMap.set(waNumber, existing);
  return existing;
}

// -------------------------
// Helper: send plain text (session message)
// used by Inbox "Send" button
// -------------------------
async function sendWhatsAppText(to, bodyText) {
  const phoneId = process.env.WA_PHONE_ID; // e.g. 791237530747480
  const token = process.env.WA_TOKEN;      // long-lived user / system token

  if (!phoneId || !token) {
    throw new Error("WA_PHONE_ID or WA_TOKEN not set");
  }

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: bodyText },
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
    console.log("❌ WhatsApp API error (text):", data);
    throw new Error("wa_send_failed");
  }

  // Log & store message
  const nowSec = Math.floor(Date.now() / 1000);
  upsertContact(to, nowSec);

  messages.push({
    waNumber: to,
    direction: "out",
    message_id: data.messages?.[0]?.id || "",
    from: "", // your business
    to,
    timestamp: String(nowSec),
    type: "text",
    text: bodyText,
    raw: data,
  });

  return data;
}

// -------------------------
// Helper: send template message
// used by Broadcast
// -------------------------
async function sendWhatsAppTemplate(to, templateName, languageCode, components) {
  const phoneId = process.env.WA_PHONE_ID;
  const token = process.env.WA_TOKEN;

  if (!phoneId || !token) {
    throw new Error("WA_PHONE_ID or WA_TOKEN not set");
  }

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,                      // must match Meta template name
      language: { code: languageCode || "en_US" },
      components: components || [],           // body/header params, images, etc.
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
    console.log("❌ WhatsApp API error (template):", data);
    throw new Error("wa_template_failed");
  }

  // Optional: store as outbound message
  const nowSec = Math.floor(Date.now() / 1000);
  upsertContact(to, nowSec);

  messages.push({
    waNumber: to,
    direction: "out",
    message_id: data.messages?.[0]?.id || "",
    from: "",
    to,
    timestamp: String(nowSec),
    type: "template",
    text: `[TEMPLATE] ${templateName}`,
    raw: data,
  });

  return data;
}

// -------------------------
// GET / → Meta webhook verification
// (this is the URL you put in Meta Webhooks)
// -------------------------
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

// -------------------------
// POST / → WhatsApp webhook
// -------------------------
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

    // Incoming messages
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

    // Status updates
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

// -------------------------
// REST API: Contacts & Messages
// -------------------------

// List contacts
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

// Messages for one contact
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

// Single outbound text message (Inbox)
app.post("/api/send", async (req, res) => {
  const { waNumber, text } = req.body || {};

  if (!waNumber || !text) {
    return res.status(400).json({ error: "waNumber and text are required" });
  }

  try {
    const data = await sendWhatsAppText(waNumber, text);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ error: "send_failed" });
  }
});

// -------------------------
// REST API: Templates (local)
// -------------------------

// Get local templates
app.get("/api/templates", (req, res) => {
  res.json(templates);
});

// Create new local template
app.post("/api/templates", (req, res) => {
  const { name, body, category } = req.body || {};
  if (!name || !body) {
    return res.status(400).json({ error: "name and body are required" });
  }

  const id = Date.now().toString();
  const tpl = {
    id,
    name,
    body,
    category: category || "utility",
  };

  templates.push(tpl);
  console.log("💾 Template saved:", tpl.name);
  res.json({ ok: true, template: tpl });
});

// OPTIONAL: Sync templates from WhatsApp Manager
// Needs env: WABA_ID + WA_TOKEN
app.get("/api/templates/sync", async (req, res) => {
  try {
    const wabaId = process.env.WABA_ID;
    const token = process.env.WA_TOKEN;

    if (!wabaId || !token) {
      return res
        .status(500)
        .json({ error: "WABA_ID or WA_TOKEN not set for sync" });
    }

    const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates?limit=200`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();

    if (!response.ok) {
      console.log("Template sync error:", data);
      return res.status(500).json({ error: "sync_failed", data });
    }

    // Clear & refill local templates list
    templates.length = 0;
    for (const t of data.data || []) {
      templates.push({
        id: t.id,
        name: t.name,
        body:
          t.components?.find((c) => c.type === "BODY")?.text || "",
        category: t.category || "utility",
      });
    }

    console.log(`🔄 Synced ${templates.length} templates from WABA`);
    res.json({ ok: true, count: templates.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "sync_failed" });
  }
});

// -------------------------
// REST API: Broadcast (manual numbers)
// Uses template messages
// -------------------------
app.post("/api/broadcast/manual", async (req, res) => {
  const { templateId, numbers } = req.body || {};

  if (!templateId) {
    return res.status(400).json({ error: "templateId is required" });
  }
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: "numbers array is required" });
  }

  const tpl =
    templates.find((t) => t.id === templateId || t.name === templateId) ||
    null;

  if (!tpl) {
    return res.status(400).json({ error: "template_not_found" });
  }

  const results = [];
  for (const num of numbers) {
    try {
      // Simple case: no variables / media yet
      await sendWhatsAppTemplate(num, tpl.name, "en_US", []);
      results.push({ to: num, ok: true });
    } catch (e) {
      console.error("Broadcast send failed for", num, e.message);
      results.push({ to: num, ok: false, error: e.message });
    }
  }

  res.json({ ok: true, results });
});

// Excel upload not implemented – front-end warns user
app.post("/api/broadcast/upload", (req, res) => {
  return res
    .status(501)
    .json({ error: "excel_upload_not_implemented_use_manual" });
});

// -------------------------
// Serve Inbox UI
// -------------------------
app.get("/inbox", (req, res) => {
  res.sendFile(path.join(__dirname, "inbox.html"));
});

// -------------------------
// Start server
// -------------------------
app.listen(port, () => {
  console.log(`\n🚀 Server running on port ${port}\n`);
});

