// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mysql = require("mysql2");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());

const rooms = {};
const MAX_DRAW_HOST = 2;

const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "tebakgambar",
});
const activePlayers = {};

// ============================
// API ENDPOINT UNTUK BUAT DAN CEK ROOM
// ============================

app.post("/api/create-room", (req, res) => {
  const { roomCode } = req.body;
  if (!roomCode) return res.json({ success: false, message: "Kode kosong" });

  db.query(
    "INSERT IGNORE INTO rooms (code) VALUES (?)",
    [roomCode],
    (err, result) => {
      if (err) {
        console.error("Gagal membuat ruangan:", err);
        return res.json({ success: false });
      }
      res.json({ success: true });
    }
  );
});

app.post("/api/check-room", (req, res) => {
  const { roomCode } = req.body;
  if (!roomCode) return res.json({ success: false });

  db.query("SELECT * FROM rooms WHERE code = ?", [roomCode], (err, results) => {
    if (err) return res.json({ success: false });

    // ✅ Room ada di DB atau masih aktif di memory
    const existsInMemory = !!rooms[roomCode];
    const existsInDB = results.length > 0;
    const isActive = results[0]?.status !== 'selesai';

    if ((existsInMemory || existsInDB) && isActive) {
      return res.json({ success: true });
    } else {
      return res.json({ success: false });
    }
  });
});

// ============================
// SOCKET IO BAGIAN GAME
// ============================

function nextTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.turnInProgress || room.players.length === 0) return;

  room.turnInProgress = true;
  clearInterval(room.timer);

  if (room.hostDrawCount >= MAX_DRAW_HOST) {
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const winner = sorted[0];

  sorted.forEach(pemain => {
    db.query(
      "INSERT INTO leaderboard (name, score, roomCode) VALUES (?, ?, ?)",
      [pemain.name, pemain.score, roomCode],
      (err) => {
        if (err) console.error("Gagal simpan leaderboard:", err);
      }
    );
  });

  io.to(roomCode).emit("game-over", {
    winnerName: winner.name,
    players: sorted
  });

// Jangan delete room di sini
// Cukup kosongkan turnQueue, biar siap untuk "main lagi"
room.turnQueue = [];
room.totalTurns = 0;
room.round = 1;
room.hasGuessed = [];
room.answer = "";
room.timer = null;
    return;
  }

  const currentDrawerId = room.turnQueue[room.currentTurnIndex % room.turnQueue.length];
  const drawer = room.players.find(p => p.id === currentDrawerId);
  if (!drawer) {
    room.currentTurnIndex++;
    room.turnInProgress = false;
    setTimeout(() => nextTurn(roomCode), 500);
    return;
  }

  // Jika host yang menggambar, hitung berapa kali
  if (drawer.id === room.hostId) {
    room.hostDrawCount++;
  }

  room.currentTurnIndex++;
  room.drawerId = drawer.id;
  room.answer = "";
  room.hasGuessed = [];

  io.to(roomCode).emit("update-clue", {
  clue1: "-",
  clue2: "-"
});

  io.to(roomCode).emit("turn-info", {
    drawerId: drawer.id,
    drawerName: drawer.name,
  });

  io.to(drawer.id).emit("start-turn", {
    drawerId: drawer.id,
    drawerName: drawer.name,
    targetSocketId: drawer.id,
  });

  setTimeout(() => {
    room.turnInProgress = false;
  }, 500);
}

io.on("connection", socket => {
  console.log("Terhubung:", socket.id);

  socket.on("join-room", ({ name, roomCode }) => {
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

      db.query(
    "INSERT IGNORE INTO rooms (code) VALUES (?)",
    [roomCode],
    (err) => {
      if (err) console.error("Gagal insert room ke DB:", err);
    }
  );

    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        players: [],
        hostId: socket.id,
        hostDrawCount: 0,
        drawerId: null,
        answer: "",
        hasGuessed: [],
        timer: null,
        turnQueue: [],
        currentTurnIndex: 0,
        turnInProgress: false,
      };
    }

    const room = rooms[roomCode];
    room.players.push({ id: socket.id, name, score: 0 });
   if (!room.turnQueue.includes(socket.id)) {
      room.turnQueue.push(socket.id);
    }


    io.to(roomCode).emit("player-list", room.players);

    // Jika ini pemain pertama (host), langsung mulai
    if (socket.id === room.hostId && room.players.length === 1) {
      setTimeout(() => nextTurn(roomCode), 1000);
    }
    activePlayers[socket.id] = { roomCode, inLeaderboard: false };
  });

  socket.on("leaderboard-keepalive", ({ name, roomCode }) => {
  socket.join(roomCode);
  // (Opsional) bisa dicatat kalau masih aktif di leaderboard
  });


  socket.on("leaderboard-active", ({ roomCode }) => {
  if (activePlayers[socket.id]) {
    activePlayers[socket.id].inLeaderboard = true;
  }
  });

  socket.on("mulai-timer", ({ roomCode, gambar }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.timeLeft = 90;
    io.to(roomCode).emit("mulai-timer");
  });

  socket.on("pilih-gambar", ({ roomCode, jawaban, daerah }) => {
  const room = rooms[roomCode];
  if (!room) return;
  room.answer = jawaban;
  room.daerah = daerah; // ✅ Simpan clue 1
  room.hasGuessed = [];
  startTimer(roomCode);
  });



  socket.on("clue", ({ roomCode, clue1, clue2 }) => {
    const data = {};
    if (clue1) data.clue1 = clue1;
    if (clue2) data.clue2 = clue2;
    io.to(roomCode).emit("update-clue", data);
  });

  socket.on("draw", data => {
    socket.to(data.roomCode).emit("draw", data);
  });
  

  socket.on("chat-message", ({ roomCode, name, message }) => {
    io.to(roomCode).emit("chat-message", { name, message });
  });

  socket.on("guess", ({ roomCode, guess, playerId }) => {
    const room = rooms[roomCode];
    if (!room || room.drawerId === playerId || room.hasGuessed.includes(playerId)) return;

    if (guess.toLowerCase() === room.answer.toLowerCase()) {
      room.hasGuessed.push(playerId);

      const player = room.players.find(p => p.id === playerId);
      if (player) {
        const time = room.timeLeft || 0;
        let score = time >= 60 ? 5 : time >= 30 ? 3 : 1;
        player.score += score;
      }

      const drawer = room.players.find(p => p.id === room.drawerId);
      if (drawer && drawer.id !== playerId) drawer.score += 5;

      io.to(roomCode).emit("correct-guess", {
        playerId,
        playerName: player?.name || "Anonim",
        guess,
      });

      io.to(roomCode).emit("player-list", room.players);
    }
  });

  socket.on("next-turn", ({ roomCode }) => {
    nextTurn(roomCode);
  });
  

  socket.on("disconnect", () => {
  console.log("Pengguna keluar:", socket.id);

  for (const code in rooms) {
    const room = rooms[code];

    // Hapus pemain dari daftar
    room.players = room.players.filter(p => p.id !== socket.id);

    io.to(code).emit("player-list", room.players);

    // 🔁 Pindahkan host kalau host lama keluar
    if (room.hostId === socket.id) {
      if (room.players.length > 0) {
        room.hostId = room.players[0].id;
        console.log("[INFO] Host baru:", room.players[0].name);
      } else {
        room.hostId = null;
      }
    }

    // ✅ Tambahkan log ini
    console.log(`[ROOM CHECK] ${code} | Sisa pemain:`, room.players.length);

    // 🔥 Hapus room jika semua keluar
    if (room.players.length === 0) {
      const currentRoomCode = code;

      setTimeout(() => {
        const stillHasPlayers = Array.from(io.sockets.sockets.values())
      .some(s => s.data?.roomCode === currentRoomCode);
        console.log(`[DELAY CHECK] ${currentRoomCode} masih ada pemain?`, stillHasPlayers);

        if (!stillHasPlayers) {
          delete rooms[currentRoomCode];
          db.query("DELETE FROM leaderboard WHERE roomCode = ?", [currentRoomCode]);
          db.query("DELETE FROM rooms WHERE code = ?", [currentRoomCode]);
          console.log("🔥 Room dan leaderboard dihapus:", currentRoomCode);
        }
      }, 3000);
    }
  }
  });



});


function startTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  let timeLeft = 90;
  room.timeLeft = timeLeft;

  clearInterval(room.timer);
  room.timer = setInterval(() => {
    timeLeft--;
    room.timeLeft = timeLeft;

    io.to(roomCode).emit("update-timer", timeLeft);

   // ⏰ Kirim clue 1 di detik ke-59
if (timeLeft === 59 && room.answer) {
  io.to(roomCode).emit("update-clue", {
    clue1: room.daerah, // ✅ clue dari data yang dikirim penggambar
  });
}


    if (timeLeft === 29 && room.answer) {
  io.to(roomCode).emit("update-clue", {
    clue2: room.answer.slice(0, 3),
  });
}


    if (timeLeft <= 0) {
      clearInterval(room.timer);
      io.to(roomCode).emit("time-up");
      setTimeout(() => nextTurn(roomCode), 1500);
    }
  }, 1000);

  function getClue1(jawaban) {
  return data ? data.daerah : "-";
}

function getClue2(jawaban) {
  return jawaban.slice(0, 3);
}

}

// ============================
// API GET LEADERBOARD
// ============================

app.get("/api/leaderboard", (req, res) => {
  const roomCode = req.query.code;
  if (!roomCode) return res.status(400).json([]);

  db.query(
    "SELECT name, score FROM leaderboard WHERE roomCode = ? ORDER BY score DESC",
    [roomCode],
    (err, results) => {
      if (err) {
        console.error("Gagal ambil leaderboard:", err);
        return res.status(500).json([]);
      }
      res.json(results);
    }
  );
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
});
