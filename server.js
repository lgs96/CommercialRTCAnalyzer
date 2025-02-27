/**
 * server.js - Enhanced HTTPS WebRTC Log Server with Continuous Analysis
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const cors = require('cors');
const { spawn } = require('child_process');

const app = express();
const port = 443; // HTTPS standard port

// SSL certificate files from Let's Encrypt
const sslOptions = {
  key: fs.readFileSync('keys/privkey.pem'),
  cert: fs.readFileSync('keys/fullchain.pem')
};

// Apply middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Keep in-memory data for each session
const sessions = {};

// Session timeout map to track inactivity (10 seconds)
const sessionTimeouts = {};
const SESSION_TIMEOUT = 10000; // 10 seconds in milliseconds

// Directory structure
const BASE_DIR = path.join(__dirname, 'logs');
const RAW_LOGS_DIR = path.join(BASE_DIR, 'logs_raw'); 
const ANALYSIS_DIR = path.join(BASE_DIR, 'logs_analyzed');

// Ensure directories exist
[BASE_DIR, RAW_LOGS_DIR, ANALYSIS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Helper: extract time from ISO string
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

// Process logs and run analyzer
function processLogsAndAnalyze(sessionId, newLogsOnly = false) {
  const sessionInfo = sessions[sessionId];
  if (!sessionInfo) return;

  // Determine folder name based on timestamp
  let folderName = sessionInfo.earliestStatsStartTime
    ? extractTimeFromISO(sessionInfo.earliestStatsStartTime)
    : new Date().toISOString().replace(/[:.]/g, '-');

  // Create session analysis directory
  const analysisFolder = path.join(ANALYSIS_DIR, sessionId, folderName);
  if (!fs.existsSync(analysisFolder)) {
    fs.mkdirSync(analysisFolder, { recursive: true });
  }

  // Save combined logs
  const combinedJsonPath = path.join(analysisFolder, `all_logs_${sessionId}.json`);
  fs.writeFileSync(combinedJsonPath, JSON.stringify(sessionInfo.logs, null, 2));

  console.log(`Processing logs for session ${sessionId}. ${newLogsOnly ? 'New logs only.' : 'All logs.'}`);

  const pyScript = path.join(__dirname, 'webrtc_analyzer.py');
  if (fs.existsSync(pyScript)) {
    console.log(`Running analyzer for session ${sessionId}...`);
    
    // Important change: Pass only sessionId as parameter
    // This allows the Python script to save files directly in the session folder
    const analyzer = spawn('python3', [
      pyScript, 
      combinedJsonPath, 
      sessionId // Pass just the sessionId without the timestamp subfolder
    ], {
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
      
      try {
        // Try to find the JSON part of the output
        const jsonStart = pyOutput.indexOf('{');
        const jsonEnd = pyOutput.lastIndexOf('}');
        
        if (jsonStart >= 0 && jsonEnd >= 0 && jsonEnd > jsonStart) {
          const jsonString = pyOutput.substring(jsonStart, jsonEnd + 1);
          const finalResults = JSON.parse(jsonString);
          console.log('Analysis results:', finalResults);
          
          // If this is a finalization, save final results
          if (sessionInfo.isClosed || sessionInfo.timedOut) {
            // Save directly to the session folder, not in the timestamp subfolder
            const sessionFolder = path.join(ANALYSIS_DIR, sessionId);
            const finalResultsPath = path.join(sessionFolder, 'final_results.json');
            fs.writeFileSync(finalResultsPath, JSON.stringify(finalResults, null, 2));
            console.log(`Saved final results to ${finalResultsPath}`);
          }
        } else {
          console.log('No valid JSON found in Python output');
        }
      } catch (err) {
        console.error('Could not parse Python output:', err);
        console.error('Raw output:', pyOutput);
      }
    });
  } else {
    console.log(`Python analyzer not found at ${pyScript}`);
  }
}

// Set up timeout for a session
function setupSessionTimeout(sessionId) {
  // Clear existing timeout if any
  if (sessionTimeouts[sessionId]) {
    clearTimeout(sessionTimeouts[sessionId]);
  }
  
  // Create new timeout
  sessionTimeouts[sessionId] = setTimeout(() => {
    console.log(`Session ${sessionId} timed out after ${SESSION_TIMEOUT/1000} seconds of inactivity`);
    
    // Mark session as timed out
    if (sessions[sessionId]) {
      sessions[sessionId].timedOut = true;
      sessions[sessionId].isClosed = true; // Also mark as closed for consistency
      
      // Run final analysis
      finalizeSession(sessionId);
    }
    
    // Clean up timeout
    delete sessionTimeouts[sessionId];
  }, SESSION_TIMEOUT);
}

// Finalize session: combine logs and run analyzer one last time
function finalizeSession(sessionId) {
  const sessionInfo = sessions[sessionId];
  if (!sessionInfo || sessionInfo.analyzed) return;
  sessionInfo.analyzed = true;  // Mark so we don't run again

  console.log(`Session ${sessionId} finalizing...`);
  
  // Run processing one last time with all logs
  processLogsAndAnalyze(sessionId, false);
}

// Endpoint to receive WebRTC logs
app.post('/log', (req, res) => {
  const logs = req.body;
  if (!Array.isArray(logs) || logs.length === 0) {
    return res.status(400).send('No logs received');
  }

  // Extract sessionId from header or first log entry
  const sessionId = 
    req.headers['x-webrtc-stats-session'] ||
    (logs[0] && logs[0].sessionId) ||
    'unknown-session';

  // Initialize session data if needed
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      logs: [],
      isClosed: false,
      timedOut: false,
      firstStatsTimestamp: null,
      earliestStatsStartTime: null,
      analyzed: false,
      lastActivityTime: Date.now()
    };
  }

  // Add logs to in-memory store
  for (const entry of logs) {
    sessions[sessionId].logs.push(entry);

    // Extract earliest startTime from stats if available
    if (entry.type === 'stats' && entry.rawStats) {
      for (const statId in entry.rawStats) {
        const statObj = entry.rawStats[statId];
        if (statObj.startTime && !sessions[sessionId].earliestStatsStartTime) {
          sessions[sessionId].earliestStatsStartTime = statObj.startTime;
        }
      }
    }

    // Check if ICE connection is closed/failed
    if (
      entry.type === 'state_change' &&
      ['closed', 'failed', 'disconnected'].includes(entry.iceConnectionState)
    ) {
      sessions[sessionId].isClosed = true;
    }
  }

  // Update last activity time
  sessions[sessionId].lastActivityTime = Date.now();

  // Save raw logs to file system in session-specific directory (only used for debugging)
  /*
  const sessionDir = path.join(RAW_LOGS_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const filename = `${timestamp}.json`;
  const filePath = path.join(sessionDir, filename);

  fs.writeFileSync(filePath, JSON.stringify(logs, null, 2));
  
  console.log(`Wrote ${logs.length} logs for session ${sessionId} to ${filename}`);
  */
  
  // Process new logs immediately
  processLogsAndAnalyze(sessionId, true);
  
  // Setup timeout for session inactivity
  setupSessionTimeout(sessionId);
  
  res.status(200).send('Logs received');

  // Finalize session if explicitly closed (don't wait for timeout)
  if (sessions[sessionId].isClosed) {
    finalizeSession(sessionId);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  // Create a summary of active sessions and their status
  const sessionSummary = {};
  
  for (const [id, session] of Object.entries(sessions)) {
    if (!session.analyzed) {  // Only include active sessions
      const elapsedSinceLastActivity = Date.now() - (session.lastActivityTime || 0);
      
      sessionSummary[id] = {
        logCount: session.logs.length,
        lastActivity: `${Math.round(elapsedSinceLastActivity / 1000)}s ago`,
        willTimeoutIn: sessionTimeouts[id] ? 
          `${Math.round((SESSION_TIMEOUT - elapsedSinceLastActivity) / 1000)}s` : 
          'No timeout',
        isClosed: session.isClosed
      };
    }
  }
  
  res.status(200).send({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeSessions: Object.keys(sessionSummary).length,
    sessions: sessionSummary
  });
});

// Create HTTPS server and start listening
const server = https.createServer(sslOptions, app);

server.listen(port, () => {
  console.log(`HTTPS WebRTC log server listening at https://logging.overlinkapp.org:${port}`);
});

// Error handling for the server
server.on('error', (error) => {
  if (error.code === 'EACCES') {
    console.error('Error: Requires elevated privileges to bind to port 443.');
    console.log('Try running with sudo or use a higher port and configure a reverse proxy.');
  } else if (error.code === 'EADDRINUSE') {
    console.error('Error: Port 443 is already in use.');
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});