// Import dependencies
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config();

// Create Express app
const app = express();
app.use(express.json());

// PORT + VERIFY TOKEN
const port = process.env.PORT || 3000;

// Use env var or fallback to vibecode
const verifyToken = process.env.VERIFY_TOKEN || "vibecode";

// ---------------------------------------------
// 🔗 MONGODB CONNECTION
// ---------------------------------------------
const mongoURI =
  process.env.MONGODB_URI ||
  "mongodb+srv://prestart_india:%401208Pavan@cluster0.iormwgk.mongodb.net/whatsappdb?retryWrites=true&w=majority&appName=Cluster0";

mongoose
  .connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.log("❌ MongoDB error: ", err));

// ---------------------------------------------
// 📦 MongoDB Schemas & Models
// ---------------------------------------------

// Contact = one WhatsApp number
const contactSchema = new mongoose.Schema(
  {
    waNumber: { type: String, unique: true }, // e.g. "919490140810"
    name: String,
    lastMessageAt: Date,
  },
  { timestamps: true }
);

// Message = inbound / outbound
const messageSchema = new mongoose.Schema(
  {
    waNumber: String, // contact WhatsApp number
    direction: { type: String, enum: ["in", "out"] }, // in = from user, out = from you
    message_id: String,
    from: String,
    to: String,
    timestamp: String,
    type: String,
    text: String,
    raw: Object,
  },
  { timestamps: true }
);

const Contact = mongoose.model("contacts", contactSchema);
const WhatsAppMessage = mongoose.model("messages", messageSchema);

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

      // Upsert contact
      const lastTime =
        msg.timestamp && !isNaN(msg.timestamp)
          ? new Date(parseInt(msg.timestamp) * 1000)
          : new Date();

      const contact = await Contact.findOneAndUpdate(
        { waNumber: from },
        { waNumber: from, lastMessageAt: lastTime },
        { upsert: true, new: true }
      );

      // Save message
      await WhatsAppMessage.create({
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
      console.log("💾 Message saved & contact updated:", contact.waNumber);
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
// 🌐 API: List contacts
// ---------------------------------------------
app.get("/api/contacts", async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ lastMessageAt: -1 });
    res.json(contacts);
  } catch (err) {
    console.error("Error fetching contacts:", err);
    res.status(500).json({ error: "failed_to_fetch_contacts" });
  }
});

// 🌐 API: Get messages for one contact
app.get("/api/messages", async (req, res) => {
  const waNumber = req.query.waNumber;
  if (!waNumber) {
    return res.status(400).json({ error: "waNumber is required" });
  }

  try {
    const msgs = await WhatsAppMessage.find({ waNumber }).sort({
      createdAt: 1,
    });
    res.json(msgs);
  } catch (err) {
    console.error("Error fetching messages:", err);
    res.status(500).json({ error: "failed_to_fetch_messages" });
  }
});

// 🌐 API: Send outbound message via Cloud API
// Needs env vars: WA_PHONE_ID, WA_TOKEN
app.post("/api/send", async (req, res) => {
  const { waNumber, text } = req.body;

  if (!waNumber || !text) {
    return res.status(400).json({ error: "waNumber and text are required" });
  }

  const phoneId = process.env.WA_PHONE_ID; // 791237530747480
  const token = process.env.WA_TOKEN; // your long-lived access token

  if (!phoneId || !token) {
    return res.status(500).json({ error: "WA_PHONE_ID or WA_TOKEN not set" });
  }

  try {
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
    console.log("📤 Send API response:", data);

    // Save outbound message
    await WhatsAppMessage.create({
      waNumber,
      direction: "out",
      message_id: data.messages?.[0]?.id || "",
      from: "", // from = your business
      to: waNumber,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: "text",
      text,
      raw: data,
    });

    res.json({ ok: true, data });
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ error: "send_failed" });
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
