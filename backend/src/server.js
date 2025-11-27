const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const cors = require("cors");
const path = require("path");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const dotenv = require("dotenv");

// Load env
dotenv.config();
const envCandidates = [
  path.resolve(__dirname, "../.env.local"),
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, "../../.env.local"),
  path.resolve(__dirname, "../../.env"),
];
for (const p of envCandidates) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Init express/socket server
const app = express();
const http = require("http");
const { Server } = require("socket.io");
const server = http.createServer(app);

// ================================
//  CORS FIX (MAIN FIX)
// ================================
const allowedOrigins = [
  "http://localhost:3000",
  "http://15.206.239.81:3000" // <-- YOUR FRONTEND
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.log("❌ CORS BLOCKED:", origin);
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ================================
//  SOCKET.IO FIX (MATCH FRONTEND)
// ================================
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.set("io", io);

io.on("connection", (socket) => {
  console.log("✅ Socket connected:", socket.id);

  socket.on("join", (userId) => {
    socket.join(userId);
  });

  socket.on("registerRiderVehicleType", (vehicleType) => {
    const roomName = `vehicle:${String(vehicleType || "").trim().toLowerCase()}`;
    socket.join(roomName);
  });

  socket.on("joinRideRoom", (rideId) => {
    if (rideId) socket.join(`ride:${rideId}`);
  });

  socket.on("chatMessage", ({ rideId, fromUserId, text }) => {
    if (!rideId || !text) return;
    io.to(`ride:${rideId}`).emit("chatMessage", {
      rideId,
      fromUserId,
      text,
      at: Date.now()
    });
  });

  socket.on("riderAccepted", (ride) => {
    io.to(ride.riderId.toString()).emit("rideAccepted", ride);
  });

  socket.on("riderRejected", (ride) => {
    io.to(ride.riderId.toString()).emit("rideRejected", ride);
  });

  socket.on("riderLocation", ({ rideId, coords }) => {
    io.emit("riderLocationUpdate", { rideId, coords });
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);
  });
});

// =====================================
// Middleware
// =====================================
app.use(express.json({ limit: "10mb" }));

// Webhook raw body
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payments/webhook') return next();
  return express.json({ limit: '10mb' })(req, res, next);
});

// Normalize // in URL
app.use((req, _res, next) => {
  req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// =====================================
// MongoDB Connection
// =====================================
async function connectDatabase() {
  const opts = { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 5000 };
  const uri = process.env.MONGO_URI;

  let connected = false;
  try {
    if (uri) {
      await mongoose.connect(uri, opts);
      connected = true;
      console.log("✅ MongoDB Connected");
    } else {
      throw new Error("MONGO_URI missing");
    }
  } catch (err) {
    console.warn("⚠️ MongoDB failed:", err.message);
    console.warn("➡️ Starting In-Memory MongoDB...");

    try {
      const mongod = await MongoMemoryServer.create();
      await mongoose.connect(mongod.getUri(), opts);
      connected = true;
      console.log("✅ In-memory MongoDB started");
    } catch (e) {
      console.warn("❌ In-memory MongoDB failed:", e.message);
    }
  }

  app.set("dbOnline", connected);

  if (connected) {
    const models = [
      require("./models/User"),
      require("./models/Ride"),
      require("./models/Vehicle"),
      require("./models/Payment"),
      require("./models/Otp"),
      require("./models/Parcel")
    ];

    for (const Model of models) {
      if (Model?.createCollection) await Model.createCollection();
    }

    console.log("✅ Collections ensured");
  }
}

connectDatabase();

// =====================================
// Routes
// =====================================
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/otp", require("./routes/otpRoutes"));
app.use("/api/rides", require("./routes/rides.routes"));
app.use("/api/rider", require("./routes/rider.routes"));
app.use("/api/admin", require("./routes/adminRoutes"));
app.use("/api/parcels", require("./routes/parcelRoutes"));
app.use("/api/sos", require("./routes/sosRoutes"));
app.use("/api/pricing", require("./routes/pricingRoutes"));
app.use("/api/payments", require("./routes/payments.routes"));
app.use("/api/wallet", require("./routes/wallet.routes"));

app.use("/uploads", express.static("uploads"));

// =====================================
// Serve React Build
// =====================================
const frontendPath = path.resolve(__dirname, "../../frontend/build");

if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
  app.get("*", (req, res) => {
    if (req.url.startsWith("/api")) {
      return res.status(404).json({ success: false, message: "API route not found" });
    }
    res.sendFile(path.join(frontendPath, "index.html"));
  });
}

// =====================================
// Start Server
// =====================================
const PORT = process.env.PORT || 5000;

// IMPORTANT FIX: LISTEN ON PUBLIC IP
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});

module.exports = app;

