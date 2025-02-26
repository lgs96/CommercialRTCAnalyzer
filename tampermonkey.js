// ==UserScript==
// @name         Universal WebRTC Stats Logger
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Log all WebRTC connections and send stats to a server
// @author       You
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        // URL where logs will be sent
        serverUrl: 'https://logging.overlinkapp.org/log',

        // How often to collect stats (in milliseconds)
        statsInterval: 1000,

        // How often to send batched logs to server (in milliseconds)
        sendInterval: 2000,

        // Maximum number of logs to keep in memory before forced sending
        maxLogsBeforeSend: 1000,

        // Whether to log to console as well
        logToConsole: true,

        // Log additional details about tracks, codecs, etc.
        detailedLogs: true,

        // User identifier (optional - set to null to disable)
        userId: null
    };

    // Store for all active peer connections
    const peerConnections = new Map();

    // Store for collected logs waiting to be sent
    let pendingLogs = [];

    // Intervals
    let statsIntervalId = null;
    let sendIntervalId = null;

    // Session identifier
    const sessionId = generateSessionId();

    // Initialize when the page loads
    function initialize() {
        // Override the RTCPeerConnection constructor to track all connections
        const originalRTCPeerConnection = window.RTCPeerConnection;

        window.RTCPeerConnection = function(...args) {
            const pc = new originalRTCPeerConnection(...args);
            const pcId = 'pc_' + generateRandomId();

            // Store the connection
            peerConnections.set(pcId, {
                pc: pc,
                url: window.location.href,
                created: new Date().toISOString(),
                iceConnectionState: pc.iceConnectionState,
                connectionState: pc.connectionState,
                signalingState: pc.signalingState
            });

            // Monitor connection state changes
            pc.addEventListener('iceconnectionstatechange', () => {
                const connection = peerConnections.get(pcId);
                if (connection) {
                    connection.iceConnectionState = pc.iceConnectionState;

                    // Log state change
                    const stateLog = {
                        type: 'state_change',
                        pcId: pcId,
                        timestamp: new Date().toISOString(),
                        iceConnectionState: pc.iceConnectionState,
                        url: window.location.href,
                        sessionId: sessionId
                    };

                    logData(stateLog);

                    // If connection is closed or failed, remove from tracked connections
                    if (['closed', 'failed', 'disconnected'].includes(pc.iceConnectionState)) {
                        if (CONFIG.logToConsole) {
                            console.log(`WebRTC connection ${pcId} is ${pc.iceConnectionState}`);
                        }

                        // We'll keep it in the map for a while in case there's a reconnection
                        setTimeout(() => {
                            if (['closed', 'failed', 'disconnected'].includes(pc.iceConnectionState)) {
                                peerConnections.delete(pcId);
                                if (CONFIG.logToConsole) {
                                    console.log(`WebRTC connection ${pcId} removed from tracking`);
                                }
                            }
                        }, 30000); // Wait 30 seconds before removing
                    }
                }
            });

            pc.addEventListener('connectionstatechange', () => {
                const connection = peerConnections.get(pcId);
                if (connection) {
                    connection.connectionState = pc.connectionState;
                }
            });

            pc.addEventListener('signalingstatechange', () => {
                const connection = peerConnections.get(pcId);
                if (connection) {
                    connection.signalingState = pc.signalingState;
                }
            });

            // Log when ICE candidates are added
            const originalAddIceCandidate = pc.addIceCandidate;
            pc.addIceCandidate = function(candidate) {
                if (CONFIG.detailedLogs && candidate) {
                    const candidateLog = {
                        type: 'ice_candidate',
                        pcId: pcId,
                        timestamp: new Date().toISOString(),
                        candidate: candidate.candidate,
                        url: window.location.href,
                        sessionId: sessionId
                    };
                    logData(candidateLog);
                }
                return originalAddIceCandidate.apply(this, arguments);
            };

            if (CONFIG.logToConsole) {
                console.log(`New WebRTC connection created with ID: ${pcId}`, pc);
            }

            return pc;
        };

        // Start the stats collection interval
        startStatsCollection();

        // Start the log sending interval
        startLogSending();

        if (CONFIG.logToConsole) {
            console.log(`WebRTC stats logging initialized with session ID: ${sessionId}`);
        }
    }

    // Start collecting stats at regular intervals
    function startStatsCollection() {
        if (statsIntervalId) {
            clearInterval(statsIntervalId);
        }

        statsIntervalId = setInterval(collectStats, CONFIG.statsInterval);
    }

    // Start sending logs at regular intervals
    function startLogSending() {
        if (sendIntervalId) {
            clearInterval(sendIntervalId);
        }

        sendIntervalId = setInterval(sendLogs, CONFIG.sendInterval);
    }

    // Collect stats from all active connections
    async function collectStats() {
        if (peerConnections.size === 0) {
            return;
        }

        const timestamp = new Date().toISOString();

        for (const [pcId, connection] of peerConnections.entries()) {
            // Skip connections that are closed or failed
            if (['closed', 'failed'].includes(connection.iceConnectionState) ||
                ['closed', 'failed'].includes(connection.connectionState)) {
                continue;
            }

            try {
                const stats = await connection.pc.getStats();
                const statsObj = {};
                const processedStats = {
                    inbound: {},
                    outbound: {},
                    candidates: {},
                    codec: {},
                    certificates: {},
                    track: {},
                    mediaSource: {},
                    transport: {},
                    sctpTransport: {}
                };

                // Process and categorize stats
                stats.forEach(stat => {
                    statsObj[stat.id] = stat;

                    // Categorize stats by type
                    if (stat.type.includes('inbound')) {
                        processedStats.inbound[stat.id] = stat;
                    } else if (stat.type.includes('outbound')) {
                        processedStats.outbound[stat.id] = stat;
                    } else if (stat.type.includes('candidate')) {
                        processedStats.candidates[stat.id] = stat;
                    } else if (stat.type === 'codec') {
                        processedStats.codec[stat.id] = stat;
                    } else if (stat.type === 'certificate') {
                        processedStats.certificates[stat.id] = stat;
                    } else if (stat.type === 'track') {
                        processedStats.track[stat.id] = stat;
                    } else if (stat.type === 'media-source') {
                        processedStats.mediaSource[stat.id] = stat;
                    } else if (stat.type === 'transport') {
                        processedStats.transport[stat.id] = stat;
                    } else if (stat.type === 'sctp-transport') {
                        processedStats.sctpTransport[stat.id] = stat;
                    }
                });

                // Extract useful aggregate metrics
                const metrics = extractMetrics(processedStats);

                // Create the stats log
                const statsLog = {
                    type: 'stats',
                    pcId: pcId,
                    timestamp: timestamp,
                    url: connection.url,
                    sessionId: sessionId,
                    metrics: metrics
                };

                // Add detailed stats if configured
                if (CONFIG.detailedLogs) {
                    statsLog.rawStats = statsObj;
                }

                // Add to log collection
                logData(statsLog);

            } catch (error) {
                console.error(`Error collecting stats for connection ${pcId}:`, error);
            }
        }
    }

    // Extract key metrics from raw stats
    function extractMetrics(processedStats) {
        const metrics = {
            audio: {
                inbound: {},
                outbound: {}
            },
            video: {
                inbound: {},
                outbound: {}
            },
            transport: {},
            connection: {}
        };

        // Process inbound stats
        Object.values(processedStats.inbound).forEach(stat => {
            if (stat.kind === 'audio') {
                metrics.audio.inbound = {
                    bytesReceived: stat.bytesReceived,
                    packetsReceived: stat.packetsReceived,
                    packetsLost: stat.packetsLost,
                    jitter: stat.jitter,
                    timestamp: stat.timestamp
                };
            } else if (stat.kind === 'video') {
                metrics.video.inbound = {
                    bytesReceived: stat.bytesReceived,
                    packetsReceived: stat.packetsReceived,
                    packetsLost: stat.packetsLost,
                    framesReceived: stat.framesReceived,
                    framesDropped: stat.framesDropped,
                    framesDecoded: stat.framesDecoded,
                    frameWidth: stat.frameWidth,
                    frameHeight: stat.frameHeight,
                    timestamp: stat.timestamp
                };
            }
        });

        // Process outbound stats
        Object.values(processedStats.outbound).forEach(stat => {
            if (stat.kind === 'audio') {
                metrics.audio.outbound = {
                    bytesSent: stat.bytesSent,
                    packetsSent: stat.packetsSent,
                    timestamp: stat.timestamp
                };
            } else if (stat.kind === 'video') {
                metrics.video.outbound = {
                    bytesSent: stat.bytesSent,
                    packetsSent: stat.packetsSent,
                    framesSent: stat.framesSent,
                    frameWidth: stat.frameWidth,
                    frameHeight: stat.frameHeight,
                    timestamp: stat.timestamp
                };
            }
        });

        // Transport stats
        Object.values(processedStats.transport).forEach(stat => {
            metrics.transport = {
                selectedCandidatePairId: stat.selectedCandidatePairId,
                bytesReceived: stat.bytesReceived,
                bytesSent: stat.bytesSent,
                timestamp: stat.timestamp
            };
        });

        return metrics;
    }

    // Add a log entry to the pending logs
    function logData(data) {
        // Add some common metadata
        data.userAgent = navigator.userAgent;
        data.devicePixelRatio = window.devicePixelRatio;
        data.screenWidth = window.screen.width;
        data.screenHeight = window.screen.height;

        // Add user ID if configured
        if (CONFIG.userId) {
            data.userId = CONFIG.userId;
        }

        // Add to pending logs
        pendingLogs.push(data);

        // Log to console if configured
        if (CONFIG.logToConsole) {
            if (data.type === 'stats') {
                console.log(`WebRTC Stats for ${data.pcId}:`, data.metrics);
            } else {
                console.log(`WebRTC Event [${data.type}] for ${data.pcId}:`, data);
            }
        }

        // Send immediately if we've reached the maximum
        if (pendingLogs.length >= CONFIG.maxLogsBeforeSend) {
            sendLogs();
        }
    }

    // Send logs to the server
    async function sendLogs() {
        if (pendingLogs.length === 0) {
            return;
        }

        const logsToSend = pendingLogs;
        pendingLogs = [];

        try {
            const response = await fetch(CONFIG.serverUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-WebRTC-Stats-Session': sessionId
                },
                body: JSON.stringify(logsToSend)
            });

            if (!response.ok) {
                throw new Error(`Server returned ${response.status} ${response.statusText}`);
            }

            if (CONFIG.logToConsole) {
                console.log(`Successfully sent ${logsToSend.length} WebRTC logs to server`);
            }
        } catch (error) {
            console.error('Error sending WebRTC logs to server:', error);

            // Put the logs back in the queue for retry
            pendingLogs = [...logsToSend, ...pendingLogs];

            // Trim if the queue gets too large
            if (pendingLogs.length > CONFIG.maxLogsBeforeSend * 2) {
                pendingLogs = pendingLogs.slice(-CONFIG.maxLogsBeforeSend);
                console.warn(`WebRTC stats queue overflowed, dropped ${logsToSend.length} oldest logs`);
            }
        }
    }

    // Generate a random session ID
    function generateSessionId() {
        return 'webrtc_' + Math.random().toString(36).substring(2, 15) +
               Math.random().toString(36).substring(2, 15);
    }

    // Generate a random ID for peer connections
    function generateRandomId() {
        return Math.random().toString(36).substring(2, 15);
    }

    // Add commands to window for controlling logging
    window.WebRTCLogger = {
        // Force send logs immediately
        sendLogs: sendLogs,

        // Get current peer connections
        getPeerConnections: () => {
            return Array.from(peerConnections.entries()).map(([id, conn]) => {
                return {
                    id: id,
                    url: conn.url,
                    created: conn.created,
                    iceConnectionState: conn.iceConnectionState,
                    connectionState: conn.connectionState,
                    signalingState: conn.signalingState
                };
            });
        },

        // Set configuration options
        setConfig: (newConfig) => {
            Object.assign(CONFIG, newConfig);

            // Restart intervals if needed
            if (newConfig.statsInterval !== undefined) {
                startStatsCollection();
            }

            if (newConfig.sendInterval !== undefined) {
                startLogSending();
            }

            return CONFIG;
        },

        // Get current configuration
        getConfig: () => {
            return {...CONFIG};
        },

        // Get session ID
        getSessionId: () => sessionId,

        // Set user ID
        setUserId: (id) => {
            CONFIG.userId = id;
            return id;
        },

        // Start logging
        start: () => {
            startStatsCollection();
            startLogSending();
            return 'WebRTC logging started';
        },

        // Stop logging
        stop: () => {
            clearInterval(statsIntervalId);
            clearInterval(sendIntervalId);
            statsIntervalId = null;
            sendIntervalId = null;
            return 'WebRTC logging stopped';
        }
    };

    // Start initialization
    initialize();
})();