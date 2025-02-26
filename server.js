/**
 * server.js
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// OPTIONAL: If you want to run the Python analyzer automatically
//    you can spawn a child process.
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 1) Keep in-memory data for each session
//    sessions[sessionId] = { logs: [], lastReceived: Date.now(), isClosed: false, ... }
const sessions = {};

// Where raw JSON logs get stored on disk
const RAW_LOGS_DIR = path.join(__dirname, 'logs_raw'); 
if (!fs.existsSync(RAW_LOGS_DIR)) {
  fs.mkdirSync(RAW_LOGS_DIR, { recursive: true });
}

// Where CSV analysis is ultimately stored
const ANALYSIS_DIR = path.join(__dirname, 'logs_analyzed');
if (!fs.existsSync(ANALYSIS_DIR)) {
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
}

// 2) Handle incoming logs
app.post('/log', (req, res) => {
  const logs = req.body;
  if (!Array.isArray(logs) || logs.length === 0) {
    return res.status(400).send('No logs received');
  }

  // The sessionId we get from the header or from the first log
  let sessionId =
    req.headers['x-webrtc-stats-session'] ||
    (logs[0] && logs[0].sessionId) ||
    'unknown-session';

  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      logs: [],
      isClosed: false,
      firstStatsTimestamp: null, // We’ll track earliest stats log
      earliestStatsStartTime: null // From rawStats if available
    };
  }

  // 3) Push these logs into our memory store
  for (const entry of logs) {
    sessions[sessionId].logs.push(entry);

    // If we find a "type: stats" entry, try to extract earliest “startTime”
    if (entry.type === 'stats' && entry.rawStats) {
      // rawStats is a dictionary of RTCStats objects, e.g. "IT01V3066186979": { ... }
      // Some stats dumps have a top-level 'startTime' or similar.
      // (Below we just show a typical check—adapt as needed.)
      for (const statId in entry.rawStats) {
        const statObj = entry.rawStats[statId];
        // Some browsers store a custom field like `startTime` in each inbound-rtp stat
        if (statObj.startTime && !sessions[sessionId].earliestStatsStartTime) {
          sessions[sessionId].earliestStatsStartTime = statObj.startTime;
        }
      }
    }

    // Also check if ICE disconnected/closed => we might finalize
    if (
      entry.type === 'state_change' &&
      ['closed', 'failed', 'disconnected'].includes(entry.iceConnectionState)
    ) {
      sessions[sessionId].isClosed = true;
    }
  }

  // 4) Write raw logs to disk as well (optional). 
  //    One way is to store each POST as a single file or append to one file.
  //    For simplicity, store each request in a new file.
  const nowIso = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${sessionId}_${nowIso}.json`;
  const filePath = path.join(RAW_LOGS_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(logs, null, 2));

  res.status(200).send('Logs received');

  // 5) Optionally, trigger a “finalize” if the session is closed
  if (sessions[sessionId].isClosed) {
    finalizeSession(sessionId);
  }
});

// 6) On “finalizeSession,” we gather all logs, figure out final folder name, run analyzer, etc.
function finalizeSession(sessionId) {
    const sessionInfo = sessions[sessionId];
    if (!sessionInfo || sessionInfo.analyzed) return;
    sessionInfo.analyzed = true;  // Mark so we don’t run again
  
    let folderName = sessionInfo.earliestStatsStartTime
      ? extractTimeFromISO(sessionInfo.earliestStatsStartTime)
      : new Date().toISOString().replace(/[:.]/g, '-');
  
    const analysisFolder = path.join(ANALYSIS_DIR, folderName);
    if (!fs.existsSync(analysisFolder)) {
      fs.mkdirSync(analysisFolder, { recursive: true });
    }
  
    const combinedJsonPath = path.join(analysisFolder, `all_logs_${sessionId}.json`);
    fs.writeFileSync(combinedJsonPath, JSON.stringify(sessionInfo.logs, null, 2));
  
    console.log(`Session ${sessionId} finalizing. Wrote combined logs to: ${combinedJsonPath}`);
  
    // Spawn Python
    const pyScript = path.join(__dirname, 'webrtc_analyzer.py');
    const analyzer = spawn('python3', [pyScript, combinedJsonPath, folderName], {
      cwd: __dirname
    });
  
    let pyOutput = '';
    analyzer.stdout.on('data', (data) => {
      pyOutput += data.toString();
    });
  
    analyzer.stderr.on('data', (data) => {
      console.error('ANALYZER ERR:', data.toString());
    });
  
    analyzer.on('close', (code) => {
      console.log(`Analyzer finished with exit code ${code}`);
      
      // If the script prints JSON, parse it:
      try {
        const finalResults = JSON.parse(pyOutput);
        console.log('Analysis results:', finalResults);
      } catch (err) {
        console.error('Could not parse Python output:', err);
      }
  
      // If you wrote CSV files, they should be in `analysisFolder`
      // e.g., logs_analyzed/HH_MM_SS/*.csv
      
      // Cleanup or keep session data as needed
      // delete sessions[sessionId];
    });
  }
  

// Helper: from an ISO date string like "2025-02-26T05:46:26.093Z", returns "05_46_26"
function extractTimeFromISO(isoString) {
  try {
    const timePart = isoString.split('T')[1].split('Z')[0]; // e.g. "05:46:26.093"
    const [hh, mm, ssMillis] = timePart.split(':'); // e.g. ["05","46","26.093"]
    const [ss] = ssMillis.split('.');
    return `${hh}_${mm}_${ss}`;
  } catch {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }
}

// Start the server on port 3000 (behind Nginx HTTPS, for example)
app.listen(3000, () => {
  console.log(`WebRTC log server listening on port 3000`);
});
