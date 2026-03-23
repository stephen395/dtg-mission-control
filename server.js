/**
 * DTG Mission Control — API Server
 * Reads OpenClaw session/memory files and serves live stats.
 * No AI, no tokens — just file reading.
 *
 * Usage: node server.js
 * Runs on port 3100 by default (set PORT env to change)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PORT = process.env.PORT || 3100;
const OC_DIR = process.env.OPENCLAW_DIR || path.join(require('os').homedir(), '.openclaw');

// ── Helpers ──

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function fileMtime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Count lines in a JSONL file (fast — just counts newlines)
function countLines(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    let count = 0;
    for (let i = 0; i < buf.length; i++) { if (buf[i] === 10) count++; }
    return count;
  } catch { return 0; }
}

// Parse JSONL session file for message entries
function parseSessionMessages(filePath, maxEntries = 200) {
  const messages = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    // Read from end for most recent
    const start = Math.max(0, lines.length - maxEntries);
    for (let i = start; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'message' && entry.message) {
          messages.push({
            id: entry.id,
            timestamp: entry.timestamp,
            role: entry.message.role,
            contentLength: JSON.stringify(entry.message.content).length
          });
        } else if (entry.type === 'model_change') {
          messages.push({
            id: entry.id,
            timestamp: entry.timestamp,
            type: 'model_change',
            provider: entry.provider,
            model: entry.modelId
          });
        }
      } catch {}
    }
  } catch {}
  return messages;
}

// Get recent activity from a JSONL session — last N assistant messages with summaries
function getRecentActivity(filePath, maxItems = 10) {
  const activities = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    // Scan from end
    for (let i = lines.length - 1; i >= 0 && activities.length < maxItems; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'message' && entry.message?.role === 'assistant') {
          const text = typeof entry.message.content === 'string'
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
              : '';
          if (text.length > 10) {
            activities.push({
              timestamp: entry.timestamp,
              summary: text.substring(0, 200) + (text.length > 200 ? '...' : ''),
              role: 'assistant'
            });
          }
        } else if (entry.type === 'message' && entry.message?.role === 'user') {
          const text = typeof entry.message.content === 'string'
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
              : '';
          if (text.length > 10) {
            activities.push({
              timestamp: entry.timestamp,
              summary: text.substring(0, 200) + (text.length > 200 ? '...' : ''),
              role: 'user'
            });
          }
        }
      } catch {}
    }
  } catch {}
  return activities;
}

// ── Main Data Collection ──

// Check if OpenClaw gateway is running
let gatewayAlive = false;
function checkGateway() {
  const req = require('http').get('http://127.0.0.1:18789/health', { timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try { gatewayAlive = JSON.parse(body).ok === true; } catch { gatewayAlive = false; }
    });
  });
  req.on('error', () => { gatewayAlive = false; });
  req.on('timeout', () => { req.destroy(); gatewayAlive = false; });
}
checkGateway();
setInterval(checkGateway, 15000); // re-check every 15s

function collectDashboardData() {
  const data = {
    timestamp: new Date().toISOString(),
    agents: {},
    kpi: {},
    channels: {},
    recentActivity: [],
    modelStack: [],
    sessions: {}
  };

  // ── Agent Info from openclaw.json ──
  const config = readJSON(path.join(OC_DIR, 'openclaw.json'));
  if (config) {
    // Channels
    data.channels = {
      discord: { enabled: !!config.channels?.discord?.enabled, accounts: Object.keys(config.channels?.discord?.accounts || {}) },
      googlechat: { enabled: !!config.channels?.googlechat?.enabled },
      whatsapp: { enabled: !!config.channels?.whatsapp?.enabled }
    };

    // Model stack
    if (config.agents?.defaults?.model) {
      data.modelStack = [
        { role: 'primary', model: config.agents.defaults.model.primary },
        ...( config.agents.defaults.model.fallbacks || []).map((m, i) => ({ role: `fallback${i+1}`, model: m }))
      ];
    }
  }

  // ── Per-Agent Data ──
  // Scan actual skill directories for each agent
  const BUNDLED_SKILLS_DIR = path.join(require('os').homedir(), 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'npm', 'node_modules', 'openclaw', 'skills');

  function scanSkillDirs(...dirs) {
    const skills = new Set();
    for (const dir of dirs) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            // Verify it has a SKILL.md
            const skillFile = path.join(dir, e.name, 'SKILL.md');
            if (fs.existsSync(skillFile)) skills.add(e.name);
          }
        }
      } catch {}
    }
    return [...skills].sort();
  }

  const agentDirs = [
    { id: 'main', name: 'FallingCave', emoji: '🕳️', color: 'purple',
      sessionsDir: path.join(OC_DIR, 'agents', 'main', 'sessions'),
      skillDirs: [path.join(OC_DIR, 'agents', 'main', 'agent', 'skills')] },
    { id: 'fish', name: 'Fish', emoji: '🐟', color: 'cyan',
      sessionsDir: path.join(OC_DIR, 'agents', 'fish', 'sessions'),
      skillDirs: [path.join(OC_DIR, 'agents', 'fish', 'agent', 'skills'), path.join(OC_DIR, 'workspaces', 'fish', 'skills')] }
  ];

  let totalMessages = 0;
  let totalSessions = 0;
  const allActivity = [];

  for (const agent of agentDirs) {
    const sessionsIndex = readJSON(path.join(agent.sessionsDir, 'sessions.json'));
    const agentData = {
      id: agent.id,
      name: agent.name,
      emoji: agent.emoji,
      color: agent.color,
      status: 'offline',
      sessions: [],
      totalMessages: 0,
      todayMessages: 0,
      lastActive: null,
      currentModel: null,
      skills: []
    };

    if (sessionsIndex) {
      const today = isoToday();
      let latestUpdate = 0;

      for (const [key, session] of Object.entries(sessionsIndex)) {
        const sessionFile = session.sessionFile;
        const lines = countLines(sessionFile);
        const mtime = fileMtime(sessionFile);
        const updatedAt = session.updatedAt || 0;

        // Track latest update
        if (updatedAt > latestUpdate) {
          latestUpdate = updatedAt;
          // Extract model from skills snapshot or session
          if (session.modelProvider && session.model) {
            agentData.currentModel = `${session.modelProvider}/${session.model}`;
          }
        }

        // Parse messages for counts
        const msgs = parseSessionMessages(sessionFile, 500);
        const msgCount = msgs.filter(m => m.role).length;
        agentData.totalMessages += msgCount;

        // Count today's messages
        const todayMsgs = msgs.filter(m => m.timestamp && m.timestamp.startsWith(today)).length;
        agentData.todayMessages += todayMsgs;

        agentData.sessions.push({
          id: session.sessionId,
          updatedAt: updatedAt,
          lines: lines,
          origin: session.origin?.label || session.origin?.provider || 'unknown',
          channel: session.lastChannel || session.origin?.provider || 'direct'
        });

        // Get recent activity for this session
        const recent = getRecentActivity(sessionFile, 5);
        for (const act of recent) {
          allActivity.push({
            ...act,
            agent: agent.name,
            agentId: agent.id,
            color: agent.color,
            channel: session.lastChannel || session.origin?.provider || 'direct'
          });
        }

        totalMessages += msgCount;
        totalSessions++;
      }

      // Status: online if gateway is alive (agents are running), offline if gateway is down
      if (latestUpdate > 0) {
        agentData.lastActive = new Date(latestUpdate).toISOString();
      }
      agentData.status = gatewayAlive ? 'online' : 'offline';

      // Scan actual skill directories on disk (not session snapshot which can be stale)
      agentData.skills = scanSkillDirs(...agent.skillDirs);
    }

    data.agents[agent.id] = agentData;
  }

  // ── KPIs ──
  data.kpi = {
    gatewayAlive: gatewayAlive,
    activeAgents: Object.values(data.agents).filter(a => a.status === 'online').length,
    totalAgents: agentDirs.length,
    totalMessagesToday: Object.values(data.agents).reduce((sum, a) => sum + a.todayMessages, 0),
    totalMessagesAllTime: totalMessages,
    totalSessions: totalSessions,
    systemHealth: 'healthy' // Could check gateway port, etc.
  };

  // ── Recent Activity (sorted, last 20) ──
  data.recentActivity = allActivity
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 20);

  // ── Memory files (daily logs) ──
  const memoryDirs = [
    { agent: 'fish', dir: path.join(OC_DIR, 'workspaces', 'fish', 'memory') },
    { agent: 'main', dir: path.join(OC_DIR, 'workspace', 'memory') }
  ];
  data.dailyLogs = [];
  for (const mem of memoryDirs) {
    try {
      const files = fs.readdirSync(mem.dir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
      for (const f of files) {
        const stat = fs.statSync(path.join(mem.dir, f));
        data.dailyLogs.push({
          agent: mem.agent,
          date: f.replace('.md', ''),
          sizeBytes: stat.size,
          modified: stat.mtime.toISOString()
        });
      }
    } catch {}
  }
  data.dailyLogs.sort((a, b) => b.date.localeCompare(a.date));

  return data;
}

// ── HTTP Server ──

const server = http.createServer((req, res) => {
  // CORS headers for GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Normalize path — strip leading /api if present (Tailscale Funnel doubles it)
  const url = req.url.replace(/^\/api/, '');

  if ((url === '/dashboard' || url === '/api/dashboard') && req.method === 'GET') {
    try {
      const data = collectDashboardData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if ((url === '/health' || url === '/api/health') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // ── GET /models — return current model config + available models ──
  if ((url === '/models' || url === '/api/models') && req.method === 'GET') {
    try {
      const config = readJSON(path.join(OC_DIR, 'openclaw.json'));
      // All available models from all providers
      const available = [];
      for (const [provider, pconf] of Object.entries(config.models?.providers || {})) {
        for (const m of (pconf.models || [])) {
          available.push({
            id: `${provider}/${m.id}`,
            name: m.name || m.id,
            provider,
            reasoning: m.reasoning || false,
            cost: m.cost || {},
            free: (!m.cost?.input && !m.cost?.output) || (m.cost?.input === 0 && m.cost?.output === 0)
          });
        }
      }
      // Per-agent config
      const agents = {};
      // Main agent uses defaults
      agents.main = {
        name: 'FallingCave',
        primary: config.agents?.defaults?.model?.primary || '',
        fallbacks: config.agents?.defaults?.model?.fallbacks || []
      };
      // Fish has own model block
      for (const a of (config.agents?.list || [])) {
        if (a.id === 'fish' && a.model) {
          agents.fish = {
            name: 'Fish',
            primary: a.model.primary || '',
            fallbacks: a.model.fallbacks || []
          };
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents, available }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── POST /models — update model config for an agent ──
  if ((url === '/models' || url === '/api/models') && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { agentId, primary, fallbacks } = JSON.parse(body);
        if (!agentId || !primary || !Array.isArray(fallbacks)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Required: agentId, primary, fallbacks[]' }));
          return;
        }
        const configPath = path.join(OC_DIR, 'openclaw.json');
        const config = readJSON(configPath);
        if (!config) throw new Error('Cannot read openclaw.json');

        if (agentId === 'main') {
          config.agents.defaults.model.primary = primary;
          config.agents.defaults.model.fallbacks = fallbacks;
        } else if (agentId === 'fish') {
          const fishAgent = config.agents.list.find(a => a.id === 'fish');
          if (!fishAgent) throw new Error('Fish agent not found in config');
          if (!fishAgent.model) fishAgent.model = {};
          fishAgent.model.primary = primary;
          fishAgent.model.fallbacks = fallbacks;
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown agentId: ' + agentId }));
          return;
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agentId, primary, fallbacks }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Serve the dashboard HTML itself at root
  if ((url === '/' || url === '') && req.method === 'GET') {
    const htmlPath = path.join(__dirname, 'index.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('index.html not found');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`DTG Mission Control running on http://localhost:${PORT}`);
  console.log(`  Dashboard UI:   http://localhost:${PORT}/`);
  console.log(`  Dashboard data: http://localhost:${PORT}/api/dashboard`);
  console.log(`  Health check:   http://localhost:${PORT}/api/health`);
  console.log(`  OpenClaw dir:   ${OC_DIR}`);
});
