import React, { useState, useEffect, useRef } from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  IconButton,
  Badge,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  Divider,
  Tooltip,
  Paper,
  Alert,
} from "@mui/material";
import {
  FlashOn,
  Pause,
  PlayArrow,
  NotificationsActive,
  TrendingUp,
  AccessTime,
  LocalGasStation,
  SwapHoriz,
  Refresh,
} from "@mui/icons-material";
import { getOpportunities } from "../services/api";

// DEX labels for display
const DEX_LABELS = {
  uniswap_v2: "Uni V2",
  uniswap_v3: "Uni V3",
  sushiswap: "Sushi",
  balancer: "Balancer",
  curve: "Curve",
};

const RealTimeOpportunities = ({ wsEndpoint }) => {
  const [opportunities, setOpportunities] = useState([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const wsRef = useRef(null);
  const audioRef = useRef(null);
  const pollIntervalRef = useRef(null);

  // Fetch opportunities via REST API (fallback when WebSocket not connected)
  const fetchOpportunities = async () => {
    if (connected) return; // Skip if WebSocket is connected
    try {
      setLoading(true);
      const data = await getOpportunities();
      if (data?.opportunities && Array.isArray(data.opportunities)) {
        // Transform API data to match WebSocket format
        const transformed = data.opportunities.map((opp, idx) => ({
          id: opp.id || `api-${idx}-${Date.now()}`,
          route: opp.route || opp.swapData?.route || "Unknown Route",
          dexPath: opp.dexPath || [],
          netProfit: opp.netProfit || opp.profit || "0",
          gasCost: opp.gasCost || opp.gasCostDai || "0",
          mlScore: opp.mlScore || 0.5,
          timestamp: opp.timestamp || Date.now(),
        }));
        setOpportunities(transformed);
      }
    } catch (err) {
      console.error("[RealTimeOpportunities] API fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  // Sound notification for high-value opportunities
  useEffect(() => {
    audioRef.current = new Audio("/notification.mp3");

    // Initial fetch
    fetchOpportunities();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // Start/stop polling based on WebSocket connection
  useEffect(() => {
    if (!connected && !paused) {
      // Start polling when WebSocket is disconnected
      pollIntervalRef.current = setInterval(fetchOpportunities, 15000);
    } else if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [connected, paused]);

  // WebSocket connection for real-time updates
  useEffect(() => {
    const connectWebSocket = () => {
      const endpoint = wsEndpoint || `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

      try {
        wsRef.current = new WebSocket(endpoint);

        wsRef.current.onopen = () => {
          setConnected(true);
          console.log("[RealTimeOpportunities] WebSocket connected");
        };

        wsRef.current.onmessage = (event) => {
          if (paused) return;

          try {
            const data = JSON.parse(event.data);

            if (data.type === "opportunity") {
              handleNewOpportunity(data.payload);
            } else if (data.type === "price_update") {
              // Could trigger opportunity recalculation
            }
          } catch (err) {
            console.error("[RealTimeOpportunities] Parse error:", err);
          }
        };

        wsRef.current.onclose = () => {
          setConnected(false);
          console.log("[RealTimeOpportunities] WebSocket disconnected");
          // Reconnect after 5 seconds
          setTimeout(connectWebSocket, 5000);
        };

        wsRef.current.onerror = (err) => {
          console.error("[RealTimeOpportunities] WebSocket error:", err);
        };
      } catch (err) {
        console.error("[RealTimeOpportunities] Connection failed:", err);
        setTimeout(connectWebSocket, 5000);
      }
    };

    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [wsEndpoint, paused]);

  const handleNewOpportunity = (opp) => {
    // Add timestamp if not present
    const newOpp = {
      ...opp,
      id: opp.id || Date.now(),
      timestamp: opp.timestamp || Date.now(),
    };

    // Play sound for high-value opportunities
    if (soundEnabled && parseFloat(opp.netProfit) > 0.01) {
      audioRef.current?.play().catch(() => {});
    }

    // Add to list (keep last 20)
    setOpportunities((prev) => {
      const updated = [newOpp, ...prev.filter(o => o.id !== newOpp.id)];
      return updated.slice(0, 20);
    });
  };

  const formatProfit = (profit) => {
    const num = parseFloat(profit || 0);
    if (num >= 0) {
      return `+${num.toFixed(4)}`;
    }
    return num.toFixed(4);
  };

  const getAge = (timestamp) => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  };

  const getProfitColor = (profit) => {
    const num = parseFloat(profit || 0);
    if (num >= 0.05) return "success.main";
    if (num >= 0.01) return "warning.main";
    if (num > 0) return "text.secondary";
    return "error.main";
  };

  // Use real opportunities only - no demo data
  const displayOpportunities = opportunities;

  return (
    <Card>
      <CardContent>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 2 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Badge
              color={connected ? "success" : "error"}
              variant="dot"
              overlap="circular"
            >
              <FlashOn color="primary" />
            </Badge>
            <Typography variant="h6">Real-Time Opportunities</Typography>
            <Chip
              label={connected ? "Live" : "Connecting..."}
              size="small"
              color={connected ? "success" : "default"}
              sx={{ ml: 1 }}
            />
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Tooltip title={paused ? "Resume feed" : "Pause feed"}>
              <IconButton onClick={() => setPaused(!paused)} size="small">
                {paused ? <PlayArrow /> : <Pause />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Sound alerts">
              <IconButton
                onClick={() => setSoundEnabled(!soundEnabled)}
                size="small"
                color={soundEnabled ? "primary" : "default"}
              >
                <NotificationsActive />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        {!connected && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            WebSocket disconnected. Showing cached data. Reconnecting...
          </Alert>
        )}



        <List sx={{ maxHeight: 400, overflow: "auto" }}>
          {displayOpportunities.map((opp, idx) => (
            <React.Fragment key={opp.id}>
              <ListItem
                sx={{
                  bgcolor: "background.default",
                  borderRadius: 1,
                  mb: 1,
                  flexDirection: "column",
                  alignItems: "flex-start",
                }}
              >
                <Box sx={{ width: "100%", display: "flex", justifyContent: "space-between", mb: 1 }}>
                  <Typography variant="body2" fontWeight="medium">
                    {opp.route || "Unknown Route"}
                  </Typography>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    <AccessTime fontSize="small" sx={{ fontSize: 14 }} color="action" />
                    <Typography variant="caption" color="text.secondary">
                      {getAge(opp.timestamp)}
                    </Typography>
                  </Box>
                </Box>

                {/* DEX Path */}
                <Box sx={{ display: "flex", gap: 0.5, mb: 1, flexWrap: "wrap" }}>
                  {(opp.dexPath || []).map((dex, dexIdx) => (
                    <React.Fragment key={dexIdx}>
                      <Chip
                        label={DEX_LABELS[dex] || dex}
                        size="small"
                        sx={{ height: 20, fontSize: "0.65rem" }}
                      />
                      {dexIdx < (opp.dexPath?.length || 0) - 1 && (
                        <SwapHoriz fontSize="small" sx={{ color: "text.secondary" }} />
                      )}
                    </React.Fragment>
                  ))}
                </Box>

                {/* Metrics Row */}
                <Box sx={{ width: "100%", display: "flex", justifyContent: "space-between" }}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                      <TrendingUp fontSize="small" color="success" />
                      <Typography
                        variant="body2"
                        fontWeight="bold"
                        color={getProfitColor(opp.netProfit)}
                      >
                        {formatProfit(opp.netProfit)} ETH
                      </Typography>
                    </Box>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                      <LocalGasStation fontSize="small" color="action" />
                      <Typography variant="caption" color="text.secondary">
                        {parseFloat(opp.gasCost || 0).toFixed(4)} ETH
                      </Typography>
                    </Box>
                  </Box>
                  <Tooltip title="ML Confidence Score">
                    <Chip
                      label={`${((opp.mlScore || 0) * 100).toFixed(0)}%`}
                      size="small"
                      color={
                        (opp.mlScore || 0) > 0.8
                          ? "success"
                          : (opp.mlScore || 0) > 0.6
                          ? "warning"
                          : "default"
                      }
                    />
                  </Tooltip>
                </Box>
              </ListItem>
            </React.Fragment>
          ))}

          {displayOpportunities.length === 0 && (
            <Paper sx={{ p: 3, textAlign: "center", bgcolor: "background.default" }}>
              <Typography color="text.secondary">
                No opportunities detected yet. The system is monitoring pools...
              </Typography>
            </Paper>
          )}
        </List>

        {/* Summary Stats */}
        <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: "divider" }}>
          <Box sx={{ display: "flex", justifyContent: "space-between" }}>
            <Typography variant="caption" color="text.secondary">
              Total opportunities (last hour): {displayOpportunities.length}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Avg profit: {formatProfit(
                displayOpportunities.reduce((sum, o) => sum + parseFloat(o.netProfit || 0), 0) /
                  (displayOpportunities.length || 1)
              )} ETH
            </Typography>
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
};

export default RealTimeOpportunities;

