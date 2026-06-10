// backend/index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
const backendMapDir = path.join(__dirname, 'map');
const assetManifestPath = path.join(__dirname, 'assets-manifest.json');

const MAP_FILES = {
  'The Skeld': {
    mapFile: 'generated_map.json',
    propsFile: 'props.json'
  },
  Polus: {
    mapFile: 'polus_generated_map.json',
    propsFile: 'polus_props.json'
  }
};

function normalizeMapName(value) {
  return value === 'Polus' ? 'Polus' : 'The Skeld';
}

function mapFilesFor(value) {
  const map = normalizeMapName(value);
  const files = MAP_FILES[map] || MAP_FILES['The Skeld'];

  return {
    map,
    mapPath: path.join(backendMapDir, files.mapFile),
    propsPath: path.join(backendMapDir, files.propsFile)
  };
}

app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

let gtaskList = [
  { id: 1, name: 'Upload data'}, 
  { id: 2, name: 'Swipe Card'}, 
  { id: 3, name: 'Calibrate Distributor'}, 
  { id: 4, name: 'Submit your key'},
  { id: 5, name: 'Clean Oxygen Tank'},
  { id: 6, name: 'Fix Wiring'},
  { id: 7, name: 'Calibrate Reactor'},
  { id: 8, name: 'Complete a medbay scan'},
  { id: 9, name: 'Clear Asteroids'},
  { id: 11, name: 'Prime Shields'}
]

function processVotes(lobby) {
  if (!lobby || !lobby.inMeeting) return;
  const counts = {};
  const playerIds = Object.keys(lobby.players);
  const players = Object.values(lobby.players);

  for (const player of players) {
    if (!player.isDead) {
      const choice = player.votedFor;
      if (!choice) continue;
      counts[choice] = (counts[choice] || 0) + 1;
    }
  }

  const max = Math.max(0, ...Object.values(counts));
  const topChoices = Object.entries(counts)
    .filter(([, cnt]) => cnt === max)
    .map(([choice]) => choice);

  let playerVotedOut = 'skip';
  if (topChoices.length === 1 && topChoices[0] !== 'skip') {
    playerVotedOut = topChoices[0];
  }

  const ejectedPlayer = playerVotedOut !== 'skip' && lobby.players[playerVotedOut]
    ? {
        id: playerVotedOut,
        ign: lobby.players[playerVotedOut].ign,
        color: lobby.players[playerVotedOut].color,
        role: publicLobbySettings(lobby).revealEjectRole ? lobby.players[playerVotedOut].role : undefined,
        roleRevealed: publicLobbySettings(lobby).revealEjectRole
      }
    : null;

  lobby.inMeeting = false;
  if (lobby.meetingData?.timerId) {
    clearInterval(lobby.meetingData.timerId);
    lobby.meetingData.timerId = null;
  }

  if (ejectedPlayer) {
    console.log("Voting out: ", playerVotedOut);
    lobby.players[playerVotedOut].isDead = true;
    io.to(playerVotedOut).emit('youHaveBeenKilled');
  } else {
    console.log('Skip vote');
  }

  const spawnPositions = resetPlayersToMeetingSpawns(lobby);

  playerIds.forEach((key) => {
    lobby.players[key].votedFor = "";
    lobby.players[key].wasVotedBy = [];
  });

  io.in(lobby.code).emit('emergencyMeetingEnded', {
    playerVotedOut,
    ejectedPlayer,
    spawnPositions,
    voteCounts: counts,
    revealEjectRole: publicLobbySettings(lobby).revealEjectRole
  });
  io.in(lobby.code).emit('players', lobby.players);
  checkWinState(lobby);
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readAssetManifest() {
  try {
    const manifest = JSON.parse(fs.readFileSync(assetManifestPath, 'utf8'));
    return {
      glbs: Array.isArray(manifest.glbs) ? manifest.glbs : [],
      textures: Array.isArray(manifest.textures) ? manifest.textures : []
    };
  } catch {
    return { glbs: [], textures: [] };
  }
}

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: '3d-among-us-backend'
  });
});

app.get('/api/props', (req, res) => {
  const { propsPath } = mapFilesFor(req.query.map);
  res.json(readJsonFile(propsPath, []));
});

app.post('/api/props', (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected a JSON array of prop entries.' });
  }

  const { propsPath } = mapFilesFor(req.query.map);
  fs.mkdirSync(path.dirname(propsPath), { recursive: true });
  fs.writeFileSync(propsPath, `${JSON.stringify(req.body, null, 2)}\n`);
  res.json({ ok: true, count: req.body.length });
});

app.get('/api/map-data', (req, res) => {
  const { mapPath } = mapFilesFor(req.query.map);
  res.json(readJsonFile(mapPath, []));
});

app.post('/api/map-data', (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected a JSON array of map entries.' });
  }

  const { mapPath } = mapFilesFor(req.query.map);
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });
  fs.writeFileSync(mapPath, `${JSON.stringify(req.body, null, 2)}\n`);
  res.json({ ok: true, count: req.body.length });
});

app.post('/api/maps', (req, res) => {
  const { map, mapPath, propsPath } = mapFilesFor(req.body?.map);
  const empty = [];

  if (!fs.existsSync(mapPath)) {
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, `${JSON.stringify(empty, null, 2)}\n`);
  }
  if (!fs.existsSync(propsPath)) {
    fs.mkdirSync(path.dirname(propsPath), { recursive: true });
    fs.writeFileSync(propsPath, `${JSON.stringify(empty, null, 2)}\n`);
  }

  res.json({ ok: true, map });
});

app.get('/api/assets', (req, res) => {
  const manifest = readAssetManifest();
  res.json({
    glbs: manifest.glbs.filter((value, index, arr) => arr.indexOf(value) === index),
    textures: manifest.textures.filter((value, index, arr) => arr.indexOf(value) === index)
  });
});

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});


// In‑memory store of lobbies
// lobbyCode → { players: { socketId: { x,z,color,yaw } } }
const lobbies = {};

const DEFAULT_LOBBY_SETTINGS = {
  map: 'The Skeld',
  impostorCount: 1,
  revealEjectRole: true,
  meetingDuration: 45,
  killCooldown: 30
};

function normalizeLobbySettings(input = {}) {
  const settings = typeof input === 'object' && input !== null ? input : {};
  const map = normalizeMapName(settings.map);
  const impostorCount = Number(settings.impostorCount) === 2 ? 2 : 1;
  const revealEjectRole = settings.revealEjectRole === false ? false : true;
  const meetingDuration = Number(settings.meetingDuration) === 90 ? 90 : 45;
  const requestedKillCooldown = Number(settings.killCooldown);
  const killCooldown = [15, 30, 45].includes(requestedKillCooldown)
    ? requestedKillCooldown
    : DEFAULT_LOBBY_SETTINGS.killCooldown;

  return {
    ...DEFAULT_LOBBY_SETTINGS,
    map,
    impostorCount,
    revealEjectRole,
    meetingDuration,
    killCooldown
  };
}

function sanitizeName(value, fallback = 'Player') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (value && typeof value === 'object') {
    return sanitizeName(value.name ?? value.ign ?? value.username, fallback);
  }
  return fallback;
}

function publicLobbySettings(lobby) {
  return normalizeLobbySettings(lobby?.settings);
}

function publicLineupPlayer(player) {
  return {
    id: player.id,
    ign: player.ign,
    color: player.color,
    role: player.role,
    isDead: Boolean(player.isDead)
  };
}

function winningLineupPlayers(lobby, winner) {
  const winnerRole = winner === 'impostors' ? 'Impostor' : 'Crewmate';
  return Object.values(lobby.players)
    .filter(player => player.role === winnerRole)
    .map(publicLineupPlayer);
}

function chooseImpostors(playerIds, requestedCount) {
  const maxImpostors = Math.max(1, Math.min(Number(requestedCount) || 1, playerIds.length - 1));
  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  return new Set(shuffled.slice(0, maxImpostors));
}

function emitWin(lobby, winner) {
  if (!lobby || lobby.winner) return;

  lobby.winner = winner;
  lobby.gameStarted = false;
  lobby.inMeeting = false;

  if (lobby.meetingData?.timerId) {
    clearInterval(lobby.meetingData.timerId);
    lobby.meetingData.timerId = null;
  }

  io.in(lobby.code).emit('win', {
    winner,
    players: winningLineupPlayers(lobby, winner)
  });
  io.in(lobby.code).emit('declareWinner', winner);
}

function recomputeTaskTotals(lobby) {
  const crewmates = Object.values(lobby.players)
    .filter(player => player.role === 'Crewmate');
  const tasks = crewmates.flatMap(player => Array.isArray(player.tasks) ? player.tasks : []);
  lobby.totalTasks = tasks.length;
  lobby.totalTasksCompleted = tasks.filter(task => task.completed).length;
  return tasks;
}

function checkWinState(lobby) {
  if (!lobby || !lobby.gameStarted || lobby.winner) return null;

  const players = Object.values(lobby.players);
  if (!players.length) return null;

  const crewmates = players.filter(player => player.role === 'Crewmate');
  const impostors = players.filter(player => player.role === 'Impostor');
  const aliveCrewmates = crewmates.filter(player => !player.isDead).length;
  const aliveImpostors = impostors.filter(player => !player.isDead).length;

  const crewmateTasks = recomputeTaskTotals(lobby);
  if (crewmateTasks.length > 0 && crewmateTasks.every(task => task.completed)) {
    emitWin(lobby, 'crewmates');
    return 'crewmates';
  }

  if (impostors.length > 0 && aliveImpostors === 0) {
    emitWin(lobby, 'crewmates');
    return 'crewmates';
  }

  if (aliveImpostors > 0 && aliveImpostors >= aliveCrewmates) {
    emitWin(lobby, 'impostors');
    return 'impostors';
  }

  return null;
}

const DEFAULT_SPAWNS = [
  { x: 0.30, z: -2.70 },
  { x: 0.70, z: -2.55 },
  { x: -0.10, z: -2.55 },
  { x: 0.40, z: -2.35 },
  { x: 0.90, z: -2.75 }
];

function loadMapSpawns(mapName = 'The Skeld') {
  const { mapPath, map } = mapFilesFor(mapName);

  try {
    const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw.rooms)
        ? raw.rooms
        : [raw];

    const spawns = list
      .filter(entry => entry.type === 'spawn')
      .filter(entry => Number.isFinite(entry.x) && Number.isFinite(entry.z))
      .map(entry => ({ x: entry.x, z: entry.z }));

    return spawns.length ? spawns : DEFAULT_SPAWNS;
  } catch (err) {
    console.warn(`Could not load ${map} spawns, using fallback spawn:`, err.message);
    return DEFAULT_SPAWNS;
  }
}

function spawnForIndex(index, mapName = 'The Skeld') {
  const mapSpawns = loadMapSpawns(mapName);
  const base = mapSpawns[index % mapSpawns.length];
  const lap = Math.floor(index / mapSpawns.length);

  return {
    x: base.x + lap * 0.35,
    z: base.z
  };
}

function resetPlayersToMeetingSpawns(lobby) {
  const mapName = publicLobbySettings(lobby).map;
  const spawnPositions = {};
  Object.entries(lobby.players).forEach(([id, player], index) => {
    const spawn = spawnForIndex(index, mapName);
    player.x = spawn.x;
    player.z = spawn.z;
    player.yaw = 0;
    spawnPositions[id] = { ...spawn, yaw: 0 };
  });
  return spawnPositions;
}

function makeCode(length = 4) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

io.on('connection', socket => {
  console.log(`Socket ${socket.id} connected`);

  socket.on('requestPlayers', (roomCode) => {
    if (!roomCode) return;
    const lobby = lobbies[roomCode];
    if (!lobby) return;
    // broadcast to everyone in the lobby
    io.in(roomCode).emit('players', lobby.players);
    io.in(roomCode).emit('testIntercept');
    console.log(`Sent players for lobby ${roomCode}, sent ${Object.keys(lobby.players).length} players`);
  });

  socket.on('killPlayer', (data) => {
    let code = data.code;
    let targetedPlayer = data.target;
    const lobby = lobbies[code];
    if (!lobby) return;
    if (lobby.inMeeting) {
      console.log('tried to kill player in meeting');
      return;
    }
    if (!lobby.gameStarted) {
      console.warn(`Tried to kill player in lobby ${code} but game not started`);
      return;
    }
    const playerId = socket.id;
    if (!lobby.players[playerId]) {
      console.warn(`Tried to kill player ${playerId} but not in lobby ${code}`);
      return;
    }
    const killer = lobby.players[socket.id];
    const victim = lobby.players[targetedPlayer];
    if (killer.role !== 'Impostor') {
      console.warn(`Tried to kill player ${playerId} but not an impostor in lobby ${code}. Player is ${killer.role}`);
      return;
    }
    if (killer.isDead) {
      console.warn(`Dead impostor ${playerId} tried to kill in lobby ${code}`);
      return;
    }
    if (!victim || victim.isDead) {
      console.warn(`Tried to kill player ${targetedPlayer} but target is missing or already dead in lobby ${code}`);
      return;
    }
    if (victim.role === 'Impostor') {
      console.warn(`Tried to kill another impostor ${targetedPlayer} in lobby ${code}`);
      return;
    }

    const now = Date.now();
    const cooldownUntil = Number(killer.killCooldownUntil) || 0;
    if (cooldownUntil > now) {
      io.to(socket.id).emit('killCooldown', {
        remaining: Math.ceil((cooldownUntil - now) / 1000),
        duration: publicLobbySettings(lobby).killCooldown,
        readyAt: cooldownUntil
      });
      return;
    }

    const killCooldown = publicLobbySettings(lobby).killCooldown;
    killer.killCooldownUntil = now + killCooldown * 1000;

    console.log(`Killing player ${targetedPlayer} by impostor ${playerId} in lobby ${code}`);
    io.in(code).emit('gameSound', {
      type: 'kill',
      sourceId: socket.id,
      targetId: targetedPlayer,
      position: {
        x: Number(victim.x) || 0,
        z: Number(victim.z) || 0
      }
    });
    io.to(targetedPlayer).emit('youHaveBeenKilled');
    victim.isDead = true;

    io.to(socket.id).emit('killCooldown', {
      remaining: killCooldown,
      duration: killCooldown,
      readyAt: killer.killCooldownUntil
    });
    io.in(code).emit('playerKilled', targetedPlayer);
    io.in(code).emit('players', lobby.players);
    checkWinState(lobby);
  });

  socket.on('emergencyMeeting', (data) => {
    let code = data.code;
    let playerKilled = data.playerKilled;
    const lobby = lobbies[code];
    if (!lobby) return;
    const player = lobby.players[socket.id];
    const isBodyReport = Boolean(playerKilled);

    if (lobby.inMeeting) {
      console.warn(`Tried to start emergency meeting in lobby ${code} but already in meeting`);
      io.to(socket.id).emit('emergencyMeetingDenied', {
        reason: 'A meeting is already in progress.'
      });
      return;
    }
    if (!lobby.gameStarted) {
      console.warn(`Tried to start emergency meeting in lobby ${code} but game not started`);
      io.to(socket.id).emit('emergencyMeetingDenied', {
        reason: 'The game has not started yet.'
      });
      return;
    }
    if (!player) {
      console.warn(`Tried to start emergency meeting in lobby ${code} but player was not found`);
      return;
    }
    if (player.isDead) {
      console.warn(`Dead player ${socket.id} tried to call emergency meeting in lobby ${code}`);
      io.to(socket.id).emit('emergencyMeetingDenied', {
        reason: 'Ghosts cannot call emergency meetings.'
      });
      return;
    }
    if (!isBodyReport) {
      player.emergencyMeetingsRemaining = Number.isFinite(player.emergencyMeetingsRemaining)
        ? player.emergencyMeetingsRemaining
        : 3;

      if (player.emergencyMeetingsRemaining <= 0) {
        io.to(socket.id).emit('emergencyMeetingDenied', {
          reason: 'You have no emergency meetings left.'
        });
        return;
      }

      player.emergencyMeetingsRemaining -= 1;
      io.to(socket.id).emit('emergencyMeetingsRemaining', {
        remaining: player.emergencyMeetingsRemaining
      });
    }

    if (lobby.meetingData?.timerId) {
      clearInterval(lobby.meetingData.timerId);
      lobby.meetingData.timerId = null;
    }

    const spawnPositions = resetPlayersToMeetingSpawns(lobby);
    io.in(code).emit('players', lobby.players);

    if (!isBodyReport) {
      io.in(code).emit('emergencyMeetingsRemaining', {
        playerId: socket.id,
        remaining: player.emergencyMeetingsRemaining
      });
    }

    console.log(`Starting emergency meeting in lobby ${code} by player ${socket.id}`);
    lobby.inMeeting = true;
    
    const meetingDuration = publicLobbySettings(lobby).meetingDuration;
    lobby.meetingData.discussionTime = meetingDuration;
    lobby.meetingData.calledBy = socket.id;

    const meetingTimer = setInterval(() => {
      if (lobby.inMeeting && lobby.meetingData.discussionTime > 0) {
        lobby.meetingData.discussionTime--;
      }
      if (lobby.meetingData.discussionTime <= 0) {
        console.log(`Ending emergency meeting in lobby ${code}`);
        lobby.meetingData.discussionTime = 0;

        console.log("running process votes from meeting timer running out")
        
        if (lobby.inMeeting) {
          processVotes(lobby)
        }

        // kill interval
        clearInterval(meetingTimer);
      }
    }, 1000);
    lobby.meetingData.timerId = meetingTimer;

    io.in(code).emit('emergencyMeetingStarted', {
      calledBy: socket.id,
      playerKilled: playerKilled,
      spawnPositions,
      emergencyMeetingsRemaining: player.emergencyMeetingsRemaining,
      meetingDuration,
      settings: publicLobbySettings(lobby)
    });
  });

  socket.on('castVote', (data) => {
    const { code, target } = data;
    const lobby = lobbies[code];
    if (!lobby) return;
    if (!lobby.inMeeting) {
      console.warn(`Tried to cast vote in lobby ${code} but not in meeting`);
      return;
    }
    if (!lobby.players[socket.id]) {
      console.warn(`Tried to cast vote in lobby ${code} but not a player`);
      return;
    }
    if (lobby.players[socket.id].isDead) {
      console.warn(`Dead player ${socket.id} tried to cast vote in lobby ${code}`);
      return;
    }
    if (!lobby.players[target] && target != "skip") {
      console.warn(`Tried to cast vote for ${target} in lobby ${code} but player not found`);
      return;
    }
    
    if (lobby.players[socket.id].votedFor == "") {
      if (target != "skip") {
         if (!lobby.players[target].isDead && !lobby.players[socket.id].isDead) {
            // do nun
         } else {
          return;
         }
         lobby.players[target].wasVotedBy.push(socket.id);
      }
      lobby.players[socket.id].votedFor = target
      io.to(socket.id).emit('voteCast', {
        target,
        targetName: target === 'skip' ? 'Skip' : lobby.players[target]?.ign
      });
      io.in(code).emit('voteUpdate', {
        voter: socket.id,
        voted: true
      });
      


      // check to see if everyone voted:
      let p = Object.values(lobby.players);
      let bool = false;

      p.forEach((player) => {
        if (!player.isDead) {
          if (player.votedFor == "") {
            console.log("exiting because someone hasnt voted :/")
            bool = true;
            return;
          }
        }
      })

      if (!bool) {
        console.log("running process votes from everyone submitting votes")
        processVotes(lobby);
      }

    } else {
      // user already voted! they must opt out separately
    }

  });

  socket.on('removeVote', (data) => {
    const { code, target } = data;
    const lobby = lobbies[code];
    if (!lobby) return;
    if (!lobby.inMeeting) {
      console.warn(`Tried to remove vote in lobby ${code} but not in meeting`);
      return;
    }
    if (!lobby.players[socket.id]) {
      console.warn(`Tried to remove vote in lobby ${code} but not a player`);
      return;
    }
    if (!lobby.players[target]) {
      console.warn(`Tried to remove vote for ${target} in lobby ${code} but player not found`);
      return;
    }
    
    if (lobby.players[socket.id].votedFor == "") {
      lobby.players[socket.id].votedFor = target
      lobby.players[target].wasVotedBy.push(socket.id);
    } else {
      // user already voted! they must opt out separately
    }
  })

  socket.on('startGame', (code) => {
    const lobby = lobbies[code];

      if (!lobby) return;
      if (lobby.host !== socket.id) {
        console.warn(`Non‑host tried to start ${code}`);
        return;
      } else {
        console.log(`The actual host is trying to start game ${code}`);
      }

      const ids = Object.keys(lobby.players);
      if (ids.length < 2) {
        // not enough players
        io.to(socket.id).emit('errorMsg','Need at least 2 players');
        return;
      } else {
        console.log(`Starting game in lobby ${code} with ${ids.length} players`);
      }

      const settings = publicLobbySettings(lobby);
      const impostorIds = chooseImpostors(ids, settings.impostorCount);
      const roles = {};
      ids.forEach((id) => {
        roles[id] = impostorIds.has(id) ? 'Impostor' : 'Crewmate';
      });

      // mark lobby started

      let lobbyTaskList = {}

      let lobbyPlayers = Object.values(lobby.players);

      lobby.gameStarted = true;
      lobby.winner = null;
      lobby.totalTasks = 0;
      lobby.totalTasksCompleted = 0;
      const spawnPositions = resetPlayersToMeetingSpawns(lobby);
      lobbyPlayers.forEach(player => {
        //player.x = 0
        //player.z = 0
        
        // assign 6 random tasks to each player
        player.tasks = [];
        
        let taskList = [
          { id: 1, name: 'Upload data'}, 
          { id: 2, name: 'Swipe Card'}, 
          { id: 3, name: 'Calibrate Distributor'}, 
          { id: 4, name: 'Submit your key'},
          { id: 5, name: 'Clean Oxygen Tank'},
          { id: 6, name: 'Fix Wiring'},
          { id: 7, name: 'Calibrate Reactor'},
          { id: 8, name: 'Complete a medbay scan'},
          { id: 9, name: 'Clear Asteroids'},
          { id: 11, name: 'Prime Shields'}
        ];

        if (roles[player.id] === 'Crewmate') {
          for (let i = 0; i < 6; i++) {
            let index = Math.floor(Math.random() * taskList.length);
            const task = taskList[index];
            task.completed = false; // mark as not completed
            taskList.splice(index, 1); // remove it so we don't repeat
            lobby.totalTasks += 1;
            player.tasks.push(task);
          }
        }

        console.log(`Assigned tasks to player ${player.id}:`, player.tasks);
        player.role = roles[player.id];
        player.isDead = false;
        player.killCooldownUntil = 0;
        player.emergencyMeetingsRemaining = 3;
        player.votedFor = "";
        player.wasVotedBy = [];

        lobbyTaskList[player.id] = player.tasks;
        io.to(player.id).emit('tasks', player.tasks);
        const visibleImpostors = roles[player.id] === 'Impostor'
          ? [...impostorIds].map(id => ({
              id,
              ign: lobby.players[id]?.ign,
              color: lobby.players[id]?.color
            }))
          : [];
      io.to(player.id).emit('roundStarted', {
          role: roles[player.id],
          impostors: visibleImpostors,
          players: Object.values(lobby.players).map(publicLineupPlayer),
          spawnPositions,
          settings
        });
      });
      io.in(code).emit('players', lobby.players);
  });

  socket.on('completeTask', (data) => {
    const { code, taskId } = data;
    const lobby = lobbies[code];
    if (!lobby) return;

    if (lobby.inMeeting) return;

    const player = lobby.players[socket.id];
    if (!player) return;

    const task = player.tasks.find(t => t.id === taskId);
    if (!task) return;

    let completedNow = false;
    if (!task.completed) {
      lobby.totalTasksCompleted += 1;
      task.completed = true;
      completedNow = true;
    }

    console.log(`Marked task ${taskId} as completed for player ${socket.id} in lobby ${code}`);
    recomputeTaskTotals(lobby);
    if (completedNow) {
      io.in(code).emit('gameSound', {
        type: 'taskComplete',
        sourceId: socket.id,
        taskId,
        position: {
          x: Number(player.x) || 0,
          z: Number(player.z) || 0
        }
      });
    }
    io.in(code).emit('players', lobby.players);
    io.in(code).emit('updateTaskbar', {
      totalTasksCompleted: lobby.totalTasksCompleted,
      totalTasks: lobby.totalTasks
    })
    io.to(socket.id).emit('tasks', player.tasks);
    checkWinState(lobby);

    // add task bar code here 

  });

  // Create a new game lobby
  socket.on('createGame', (payload) => {
    const createdUsername = sanitizeName(typeof payload === 'object' && payload !== null
      ? (payload.name || 'Player')
      : (payload || 'Player'));
    const settings = normalizeLobbySettings(
      typeof payload === 'object' && payload !== null ? payload.settings : {}
    );

    let code;
    do {
      code = makeCode();
      console.log(`Generated lobby code: ${code}`);
    } while (lobbies[code]);

    // initialize lobby
    lobbies[code] = {
      players: {},
      createdAt: Date.now(),
      host: socket.id,
      gameStarted: false,
      inMeeting: false,
      meetingData: {
        discussionTime: 0,
        chat: [],
        calledBy: "",
        timerId: null
      },
      totalTasksCompleted: 0,
      totalTasks: 0,
      winner: null,
      settings,
      code: code
    };

    let localLobby = lobbies[code];

    // join socket into room
    socket.join(code);

    let color = Math.floor(Math.random() * 0xffffff);

    const spawn = spawnForIndex(0, settings.map);

    // create this player's entry
    localLobby.players[socket.id] = {
      x: spawn.x, z: spawn.z,
      color: color,
      yaw: 0,
      id: socket.id,
      tasks: [],
      isHost: true,
      isDead: false,
      emergencyMeetingsRemaining: 3,
      ign: createdUsername,
      votedFor: "",
      wasVotedBy: []
    };

    // tell client the newly created code
    socket.emit('gameCreated', {
      "code": code,
      "players": localLobby.players,
      "settings": publicLobbySettings(localLobby)
    });
    console.log(`Lobby ${code}`, localLobby);
    // immediately broadcast current players in that lobby
    io.in(code).emit('players', localLobby.players);
  });

  // Join an existing game lobby
  socket.on('joinGame', data => {

    let code = data.code;
    let createdUsername = sanitizeName(data.name, 'Anonymous');

    console.log(`Socket ${socket.id} is requesting to join lobby ${code}`);
    const lobby = lobbies[code];
    if (!lobby) {
      socket.emit('noSuchGame', code);
      return;
    } else {
      if (Object.values(lobby.players).length < 10) {
        console.log(`joining lobby ${code}`);
      } else {
        socket.emit('gameFull', code);
        return;
      }
    }

    let color = (Math.floor(Math.random() * 0xffffff));

    socket.join(code);
    const spawn = spawnForIndex(Object.keys(lobby.players).length, publicLobbySettings(lobby).map);

    // add this player
    lobby.players[socket.id] = {
      x: spawn.x, z: spawn.z,
      color: color,
      yaw: 0,
      id: socket.id,
      tasks: [],
      isHost: false,
      isDead: false,
      emergencyMeetingsRemaining: 3,
      ign: createdUsername,
      votedFor: "",
      wasVotedBy: []
    };

    io.to(socket.id).emit('joinedGame', {
      "code": code,
      "players": lobby.players,
      "settings": publicLobbySettings(lobby)
    });
  });

  socket.on('meetingChat', (data) => {
    let code = data.code;
    const lobby = lobbies[code];

    if (lobby) {
      const sender = lobby.players[socket.id];
      if (!sender) return;

      if (lobby.inMeeting) {
        lobby.meetingData.chat.push({
          message: data.message,
          sender: socket.id
        });
      }

      const payload = {
        from: socket.id,
        message: data.message
      };

      if (sender.isDead) {
        Object.entries(lobby.players).forEach(([id, player]) => {
          if (player.isDead) io.to(id).emit('meetingChatMessage', payload);
        });
      } else {
        io.in(code).emit('meetingChatMessage', payload);
      }
    } else {
      console.log(`cannot send message to lobby ${code} that does not exist!`);
    }

  })

  // Movement update
  socket.on('move', ({ code, x, z }) => {
    // find which lobby this socket is in
    //console.log(`Socket ${socket.id} moving to (${x}, ${z})`);
    if (!code || !lobbies[code]) return;
    //console.log(`Socket ${socket.id} moving in lobby ${code} to (${x}, ${z})`);
    const player = lobbies[code].players[socket.id];
    if (!player) return;
    player.x = x;
    player.z = z;
    io.to(code).emit('players', lobbies[code].players);
  });

  // Rotation update
  socket.on('rotation', (data) => {
    //console.log(`Socket ${socket.id} rotation: ${yaw}`);
    //const code = Object.keys(socket.rooms).find(r => r !== socket.id);

    //console.log(`Socket ${socket.id} rotation in lobby ${data.code}: ${data.yaw}`);
    let code = data.code;
    let yaw = data.yaw;

    if (!code || !lobbies[code]) return;

    const player = lobbies[code].players[socket.id];
    if (!player) return;
    player.yaw = yaw;
    //io.in(code).emit('testIntercept');
    io.to(code).emit('players', lobbies[code].players);
  });

  // On disconnect: remove them from any lobby
  socket.on('disconnect', () => {
    console.log(`Socket ${socket.id} disconnected`);
    // for each lobby they might have been in:
    for (const [code, lobby] of Object.entries(lobbies)) {
      if (lobby.players[socket.id]) {
        delete lobby.players[socket.id];
        // notify remaining
        recomputeTaskTotals(lobby);
        io.to(code).emit('players', lobby.players);
        io.to(code).emit('updateTaskbar', {
          totalTasksCompleted: lobby.totalTasksCompleted,
          totalTasks: lobby.totalTasks
        });
        checkWinState(lobby);
        // if lobby empty, delete it
        if (Object.keys(lobby.players).length === 0) {
          delete lobbies[code];
          console.log(`Lobby ${code} closed (empty)`);
        }
      }
    }
  });
});

const PORT = Number(process.env.PORT) || 6767;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend listening on port ${PORT}`);
});
