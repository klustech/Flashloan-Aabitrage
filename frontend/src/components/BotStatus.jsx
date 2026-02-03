import React, { useState, useEffect, useCallback } from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  Grid,
  LinearProgress,
  IconButton,
  Tooltip,
  Alert,
  Divider,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
} from "@mui/material";
import {
  PlayArrow,
  Stop,
  Refresh,
  Warning,
  CheckCircle,
  Error,
  Pause,
  Settings,
} from "@mui/icons-material";
import { getHealth, getMetrics, startBot, stopBot, updateSettings } from "../services/api";

const STATUS_COLORS = {
  active: "success",
  stopped: "default",
  paused: "warning",
  error: "error",
  emergency: "error",
};

const STATUS_ICONS = {
  active: <CheckCircle fontSize="small" />,
  stopped: <Stop fontSize="small" />,
  paused: <Pause fontSize="small" />,
  error: <Error fontSize="small" />,
  emergency: <Warning fontSize="small" />,
};

const BotStatus = () => {
  const [health, setHealth] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState({
    minProfitDai: "",
    gasCeiling: "",
    slippageBips: "",
  });

  const fetchData = useCallback(async () => {
    try {
      const [healthData, metricsData] = await Promise.all([
        getHealth(),
        getMetrics(),
      ]);
      setHealth(healthData);
      setMetrics(metricsData);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to fetch bot status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleStartBot = async () => {
    try {
      await startBot();
      await fetchData();
    } catch (err) {
      setError(err.message || "Failed to start bot");
    }
  };

  const handleStopBot = async () => {
    try {
      await stopBot();
      await fetchData();
    } catch (err) {
      setError(err.message || "Failed to stop bot");
    }
  };

  const handleSettingsUpdate = async () => {
    try {
      const payload = {};
      if (settings.minProfitDai) {
        payload.minProfitDai = parseFloat(settings.minProfitDai);
      }
      if (settings.gasCeiling) {
        payload.gasCeiling = parseInt(settings.gasCeiling, 10);
      }
      if (settings.slippageBips) {
        payload.slippageBips = parseInt(settings.slippageBips, 10);
      }

      await updateSettings(payload);
      setSettingsOpen(false);
      await fetchData();
    } catch (err) {
      setError(err.message || "Failed to update settings");
    }
  };

  const getStatusLabel = () => {
    if (!health) return "unknown";
    if (health.circuitBreaker?.state === "EMERGENCY") return "emergency";
    if (health.circuitBreaker?.state === "OPEN") return "paused";
    if (health.botActive) return "active";
    return "stopped";
  };

  const status = getStatusLabel();

  if (loading && !health) {
    return (
      <Card>
        <CardContent>
          <LinearProgress />
          <Typography variant="body2" sx={{ mt: 1 }}>
            Loading bot status...
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 2 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography variant="h6">Bot Status</Typography>
            <Chip
              icon={STATUS_ICONS[status]}
              label={status.toUpperCase()}
              color={STATUS_COLORS[status]}
              size="small"
            />
          </Box>
          <Box>
            <Tooltip title="Refresh">
              <IconButton onClick={fetchData} size="small">
                <Refresh />
              </IconButton>
            </Tooltip>
            <Tooltip title="Settings">
              <IconButton onClick={() => setSettingsOpen(true)} size="small">
                <Settings />
              </IconButton>
            </Tooltip>
            {status === "active" ? (
              <Button
                variant="contained"
                color="error"
                startIcon={<Stop />}
                onClick={handleStopBot}
                size="small"
                sx={{ ml: 1 }}
              >
                Stop
              </Button>
            ) : (
              <Button
                variant="contained"
                color="success"
                startIcon={<PlayArrow />}
                onClick={handleStartBot}
                size="small"
                sx={{ ml: 1 }}
                disabled={status === "emergency"}
              >
                Start
              </Button>
            )}
          </Box>
        </Box>

        <Divider sx={{ mb: 2 }} />

        <Grid container spacing={2}>
          {/* Performance Metrics */}
          <Grid item xs={12} md={6}>
            <Typography variant="subtitle2" gutterBottom color="text.secondary">
              Performance
            </Typography>
            <Grid container spacing={1}>
              <Grid item xs={6}>
                <Box sx={{ p: 1, bgcolor: "background.default", borderRadius: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Daily P&L
                  </Typography>
                  <Typography
                    variant="h6"
                    color={
                      parseFloat(metrics?.dailyPnL || 0) >= 0
                        ? "success.main"
                        : "error.main"
                    }
                  >
                    {parseFloat(metrics?.dailyPnL || 0).toFixed(2)} DAI
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6}>
                <Box sx={{ p: 1, bgcolor: "background.default", borderRadius: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Win Rate
                  </Typography>
                  <Typography variant="h6">
                    {metrics?.winRate ? `${(metrics.winRate * 100).toFixed(1)}%` : "N/A"}
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6}>
                <Box sx={{ p: 1, bgcolor: "background.default", borderRadius: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Trades Today
                  </Typography>
                  <Typography variant="h6">
                    {metrics?.tradesToday || 0}
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6}>
                <Box sx={{ p: 1, bgcolor: "background.default", borderRadius: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Avg Profit
                  </Typography>
                  <Typography variant="h6">
                    {parseFloat(metrics?.avgProfit || 0).toFixed(4)} DAI
                  </Typography>
                </Box>
              </Grid>
            </Grid>
          </Grid>

          {/* System Metrics */}
          <Grid item xs={12} md={6}>
            <Typography variant="subtitle2" gutterBottom color="text.secondary">
              System
            </Typography>
            <Grid container spacing={1}>
              <Grid item xs={6}>
                <Box sx={{ p: 1, bgcolor: "background.default", borderRadius: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Gas Price
                  </Typography>
                  <Typography variant="h6">
                    {parseFloat(metrics?.gasPrice || 0).toFixed(1)} Gwei
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6}>
                <Box sx={{ p: 1, bgcolor: "background.default", borderRadius: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Slippage
                  </Typography>
                  <Typography variant="h6">
                    {metrics?.slippageBips || 50} bips
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6}>
                <Box sx={{ p: 1, bgcolor: "background.default", borderRadius: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Routes Found
                  </Typography>
                  <Typography variant="h6">
                    {metrics?.routesFound || 0}
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={6}>
                <Box sx={{ p: 1, bgcolor: "background.default", borderRadius: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Last Attempt
                  </Typography>
                  <Typography variant="body2">
                    {metrics?.lastAttempt
                      ? new Date(metrics.lastAttempt).toLocaleTimeString()
                      : "N/A"}
                  </Typography>
                </Box>
              </Grid>
            </Grid>
          </Grid>

          {/* Circuit Breaker Status */}
          {health?.circuitBreaker && (
            <Grid item xs={12}>
              <Typography variant="subtitle2" gutterBottom color="text.secondary">
                Circuit Breaker
              </Typography>
              <Box sx={{ p: 1, bgcolor: "background.default", borderRadius: 1 }}>
                <Grid container spacing={2}>
                  <Grid item xs={3}>
                    <Typography variant="caption" color="text.secondary">
                      State
                    </Typography>
                    <Typography variant="body1">
                      {health.circuitBreaker.state}
                    </Typography>
                  </Grid>
                  <Grid item xs={3}>
                    <Typography variant="caption" color="text.secondary">
                      Consecutive Losses
                    </Typography>
                    <Typography variant="body1">
                      {health.circuitBreaker.consecutiveLosses || 0}
                    </Typography>
                  </Grid>
                  <Grid item xs={3}>
                    <Typography variant="caption" color="text.secondary">
                      Consecutive Failures
                    </Typography>
                    <Typography variant="body1">
                      {health.circuitBreaker.consecutiveFailures || 0}
                    </Typography>
                  </Grid>
                  <Grid item xs={3}>
                    <Typography variant="caption" color="text.secondary">
                      Cooldown
                    </Typography>
                    <Typography variant="body1">
                      {health.circuitBreaker.cooldownRemaining
                        ? `${health.circuitBreaker.cooldownRemaining}s`
                        : "None"}
                    </Typography>
                  </Grid>
                </Grid>
              </Box>
            </Grid>
          )}

          {/* Service Health */}
          <Grid item xs={12}>
            <Typography variant="subtitle2" gutterBottom color="text.secondary">
              Services
            </Typography>
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
              <Chip
                label="Database"
                color={health?.database ? "success" : "error"}
                size="small"
                variant="outlined"
              />
              <Chip
                label="Redis"
                color={health?.redis ? "success" : "default"}
                size="small"
                variant="outlined"
              />
              <Chip
                label="ML Service"
                color={health?.mlService ? "success" : "default"}
                size="small"
                variant="outlined"
              />
              <Chip
                label="Flashbots"
                color={health?.flashbots ? "success" : "default"}
                size="small"
                variant="outlined"
              />
              <Chip
                label="WebSocket"
                color={health?.websocket ? "success" : "error"}
                size="small"
                variant="outlined"
              />
            </Box>
          </Grid>
        </Grid>

        {/* Settings Dialog */}
        <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)}>
          <DialogTitle>Bot Settings</DialogTitle>
          <DialogContent>
            <Box sx={{ pt: 1, display: "flex", flexDirection: "column", gap: 2 }}>
              <TextField
                label="Min Profit (DAI)"
                type="number"
                value={settings.minProfitDai}
                onChange={(e) =>
                  setSettings({ ...settings, minProfitDai: e.target.value })
                }
                helperText="Minimum profit threshold for trade execution"
                inputProps={{ step: 0.1, min: 0 }}
              />
              <TextField
                label="Gas Ceiling (Gwei)"
                type="number"
                value={settings.gasCeiling}
                onChange={(e) =>
                  setSettings({ ...settings, gasCeiling: e.target.value })
                }
                helperText="Maximum gas price for trade execution"
                inputProps={{ step: 1, min: 1 }}
              />
              <TextField
                label="Slippage (bips)"
                type="number"
                value={settings.slippageBips}
                onChange={(e) =>
                  setSettings({ ...settings, slippageBips: e.target.value })
                }
                helperText="Base slippage tolerance (1 bip = 0.01%)"
                inputProps={{ step: 10, min: 10, max: 500 }}
              />
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setSettingsOpen(false)}>Cancel</Button>
            <Button onClick={handleSettingsUpdate} variant="contained">
              Update
            </Button>
          </DialogActions>
        </Dialog>
      </CardContent>
    </Card>
  );
};

export default BotStatus;
