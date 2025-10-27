// frontend/src/App.js

import React, { useEffect, useState } from "react";
import { ZodError } from "zod";
import {
  AppBar,
  Toolbar,
  Typography,
  Box,
  Tabs,
  Tab,
  Paper,
  Button,
  Grid,
  CircularProgress,
  TextField,
  Switch,
  FormControlLabel,
  Alert,
} from "@mui/material";
import { Line } from "react-chartjs-2";
import "chart.js/auto";

import DashboardIcon from "@mui/icons-material/Dashboard";
import HistoryIcon from "@mui/icons-material/History";
import SettingsIcon from "@mui/icons-material/Settings";
import BuildIcon from "@mui/icons-material/Build";
import ProfitDetermination from "./components/ProfitDetermination";

import {
  getCurrentPrices,
  triggerArbitrage,
  getBotLogs,
  getSettings,
  updateSettings,
  startBot,
  stopBot,
} from "./services/api";
import {
  normalizeFieldErrors,
  pickSettingsFields,
  settingsDefaults,
  settingsUpdateSchema,
} from "./validation/settingsSchema";

const toLocalSettings = (incoming = {}) => ({
  ...settingsDefaults,
  ...pickSettingsFields(incoming),
});

function Dashboard({ prices, marketHistory, loadingPrices }) {
  const chartData = {
    labels: marketHistory.map((entry) => entry.time),
    datasets: [
      {
        label: "Uniswap Price (ETH)",
        data: marketHistory.map((entry) => entry.uniswapPrice),
        borderColor: "blue",
        fill: false,
      },
      {
        label: "SushiSwap Price (ETH)",
        data: marketHistory.map((entry) => entry.sushiPrice),
        borderColor: "red",
        fill: false,
      },
    ],
  };

  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Typography variant="h5" gutterBottom>
        📊 Live Market Data
      </Typography>
      {loadingPrices ? (
        <Box sx={{ textAlign: "center", py: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Grid container spacing={2}>
          <Grid item xs={6}>
            <Typography variant="body1">
              <strong>Token In:</strong> {prices.tokenIn || "DAI"}
            </Typography>
          </Grid>
          <Grid item xs={6}>
            <Typography variant="body1">
              <strong>Token Out:</strong> {prices.tokenOut || "WETH"}
            </Typography>
          </Grid>
          <Grid item xs={6}>
            <Typography variant="body1">
              <strong>Uniswap Price:</strong> {prices.uniswapPrice} ETH
            </Typography>
          </Grid>
          <Grid item xs={6}>
            <Typography variant="body1">
              <strong>SushiSwap Price:</strong> {prices.sushiPrice} ETH
            </Typography>
          </Grid>
        </Grid>
      )}
      <Box sx={{ mt: 3 }}>
        <Line data={chartData} />
      </Box>
    </Paper>
  );
}

function BotControl({ onTrigger, arbLoading }) {
  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Typography variant="h5" gutterBottom>
        ⚡ Arbitrage Execution
      </Typography>
      <Button
        variant="contained"
        color="primary"
        onClick={onTrigger}
        disabled={arbLoading}
        fullWidth
      >
        {arbLoading ? "Executing..." : "Trigger Arbitrage"}
      </Button>
    </Paper>
  );
}

function Settings({ settings, onSettingsSave, onStart, onStop }) {
  const [localSettings, setLocalSettings] = useState(() =>
    toLocalSettings(settings)
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [formSuccess, setFormSuccess] = useState(null);

  useEffect(() => {
    setLocalSettings(toLocalSettings(settings));
    setErrors({});
    setFormError(null);
    setFormSuccess(null);
  }, [settings]);

  const handleChange = (e) => {
    if (!e || !e.target) return;
    const { name, value, type, checked } = e.target;

    setLocalSettings((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : Number(value),
    }));

    setErrors((prev) => {
      if (!prev || !prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });

    setFormError(null);
    setFormSuccess(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setFormError(null);
    setFormSuccess(null);

    try {
      const payload = settingsUpdateSchema.parse(localSettings);
      const res = await onSettingsSave(payload);
      if (res && res.settings) {
        setLocalSettings(toLocalSettings(res.settings));
      }
      setErrors({});
      setFormSuccess("Settings updated successfully.");
      return res;
    } catch (error) {
      if (error instanceof ZodError) {
        const { fieldErrors, formErrors } = error.flatten();
        setErrors(normalizeFieldErrors(fieldErrors));
        setFormError(
          formErrors.length > 0
            ? formErrors.join(" ")
            : "Please correct the highlighted fields."
        );
        return null;
      }

      if (error?.response?.data) {
        const { errors: fieldErrors = {}, formErrors = [], message } =
          error.response.data;
        setErrors(normalizeFieldErrors(fieldErrors));
        setFormError(
          formErrors.length > 0
            ? formErrors.join(" ")
            : message || "Failed to save settings."
        );
        return null;
      }

      if (error?.errors || error?.formErrors) {
        const { errors: fieldErrors = {}, formErrors = [], message } = error;
        setErrors(normalizeFieldErrors(fieldErrors));
        setFormError(
          formErrors.length > 0
            ? formErrors.join(" ")
            : message || "Failed to save settings."
        );
        return null;
      }

      setFormError("Failed to save settings.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const helperTexts = {
    pollingInterval: "Seconds between polls (5 - 3600).",
    gasPriceCeiling: "Maximum gas price in gwei.",
    slippageBips: "Slippage tolerance in basis points (0 - 10000).",
    minBorrowAmount: "Set the minimum DAI value for borrowing.",
    simulationInputAmount: "Set the simulation input amount in DAI.",
  };

  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Typography variant="h5" gutterBottom>
        ⚙️ Bot Settings & Control
      </Typography>
      <Box sx={{ mb: 2 }}>
        <Alert severity={settings.botActive ? "success" : "warning"}>
          Bot status: {settings.botActive ? "Running" : "Stopped"}
        </Alert>
      </Box>
      {formError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {formError}
        </Alert>
      )}
      {formSuccess && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {formSuccess}
        </Alert>
      )}
      <FormControlLabel
        control={
          <Switch
            checked={localSettings.flashbotsDefault}
            onChange={handleChange}
            name="flashbotsDefault"
            color="primary"
          />
        }
        label="Use Flashbots by default"
      />
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Polling Interval (sec)"
            name="pollingInterval"
            type="number"
            variant="outlined"
            value={localSettings.pollingInterval}
            onChange={handleChange}
            error={Boolean(errors.pollingInterval)}
            helperText={
              errors.pollingInterval || helperTexts.pollingInterval
            }
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Gas Price Ceiling (gwei)"
            name="gasPriceCeiling"
            type="number"
            variant="outlined"
            value={localSettings.gasPriceCeiling}
            onChange={handleChange}
            error={Boolean(errors.gasPriceCeiling)}
            helperText={
              errors.gasPriceCeiling || helperTexts.gasPriceCeiling
            }
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Slippage Tolerance (bips)"
            name="slippageBips"
            type="number"
            variant="outlined"
            value={localSettings.slippageBips}
            onChange={handleChange}
            error={Boolean(errors.slippageBips)}
            helperText={errors.slippageBips || helperTexts.slippageBips}
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Minimum Borrow Amount (DAI)"
            name="minBorrowAmount"
            type="number"
            variant="outlined"
            value={localSettings.minBorrowAmount}
            onChange={handleChange}
            error={Boolean(errors.minBorrowAmount)}
            helperText={
              errors.minBorrowAmount || helperTexts.minBorrowAmount
            }
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Simulation Input Amount (DAI)"
            name="simulationInputAmount"
            type="number"
            variant="outlined"
            value={localSettings.simulationInputAmount}
            onChange={handleChange}
            error={Boolean(errors.simulationInputAmount)}
            helperText={
              errors.simulationInputAmount || helperTexts.simulationInputAmount
            }
          />
        </Grid>
      </Grid>
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={6}>
          <Button
            fullWidth
            variant="contained"
            color="primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save Settings"}
          </Button>
        </Grid>
        <Grid item xs={12} sm={6}>
          <Button
            fullWidth
            variant="outlined"
            color="secondary"
            onClick={onStart}
          >
            Start Bot
          </Button>
        </Grid>
        <Grid item xs={12}>
          <Button fullWidth variant="outlined" color="error" onClick={onStop}>
            Stop Bot
          </Button>
        </Grid>
      </Grid>
    </Paper>
  );
}

function BotLogs({ logs, loadingLogs }) {
  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Typography variant="h5" gutterBottom>
        📜 Execution Logs
      </Typography>
      {loadingLogs ? (
        <Box sx={{ textAlign: "center", py: 4 }}>
          <CircularProgress />
        </Box>
      ) : logs.length === 0 ? (
        <Typography variant="body2">No logs found.</Typography>
      ) : (
        <Box
          sx={{
            maxHeight: 300,
            overflowY: "auto",
            border: "1px solid #FFD700",
            borderRadius: 1,
            p: 2,
            fontFamily: "monospace",
            whiteSpace: "pre-line",
            backgroundColor: "#000",
            color: "#FFD700",
          }}
        >
          {logs.map((log, idx) => (
            <Typography key={idx} variant="body2" sx={{ mb: 1 }}>
              {log}
            </Typography>
          ))}
        </Box>
      )}
    </Paper>
  );
}

function App() {
  const LOG_PAGE_LIMIT = 100;
  const [activeTab, setActiveTab] = useState(0);
  const [prices, setPrices] = useState({});
  const [marketHistory, setMarketHistory] = useState([]);
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [botLogsPage, setBotLogsPage] = useState({
    logs: [],
    offset: 0,
    limit: LOG_PAGE_LIMIT,
    nextOffset: null,
    hasMore: false,
  });
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [arbLoading, setArbLoading] = useState(false);
  const [settings, setSettings] = useState({});
  const pollingFrequency = 30000;

  // Define fetchSettings to load bot settings from the API
  const fetchSettings = async () => {
    try {
      const data = await getSettings();
      setSettings(data);
    } catch (error) {
      console.error("Failed to fetch settings", error);
    }
  };

  useEffect(() => {
    fetchPrices();
    fetchLogs();
    fetchSettings();
    const interval = setInterval(() => {
      fetchPrices();
      fetchLogs();
    }, pollingFrequency);
    return () => clearInterval(interval);
  }, []);

  const fetchPrices = async () => {
    setLoadingPrices(true);
    try {
      const data = await getCurrentPrices();
      setPrices(data);
      setMarketHistory((prev) => [
        ...prev.slice(-9),
        { time: new Date().toLocaleTimeString(), ...data },
      ]);
    } finally {
      setLoadingPrices(false);
    }
  };

  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      const logResponse = await getBotLogs({
        offset: 0,
        limit: LOG_PAGE_LIMIT,
      });
      setBotLogsPage((prev) => ({
        ...prev,
        ...logResponse,
      }));
    } finally {
      setLoadingLogs(false);
    }
  };

  const handleSaveSettings = async (vals) => {
    const res = await updateSettings(vals);
    if (res && res.settings) {
      setSettings(res.settings);
    }
    return res;
  };

  const handleTriggerArbitrage = async () => {
    setArbLoading(true);
    try {
      await triggerArbitrage();
      fetchLogs();
    } finally {
      setArbLoading(false);
    }
  };

  return (
    <Box>
      <AppBar
        position="static"
        sx={{ backgroundColor: "#000", color: "#FFD700" }}
      >
        <Toolbar>
          <Typography variant="h6">Flashloan Arbitrage Bot</Typography>
        </Toolbar>
      </AppBar>
      <Tabs value={activeTab} onChange={(_, val) => setActiveTab(val)} centered>
        <Tab label="Dashboard" icon={<DashboardIcon />} />
        <Tab label="Execution" icon={<BuildIcon />} />
        <Tab label="Settings" icon={<SettingsIcon />} />
        <Tab label="Logs" icon={<HistoryIcon />} />
      </Tabs>
      <Box sx={{ p: 3 }}>
        {activeTab === 0 && (
          <Dashboard
            prices={prices}
            marketHistory={marketHistory}
            loadingPrices={loadingPrices}
          />
        )}
        {activeTab === 1 && (
          <>
            <BotControl
              onTrigger={handleTriggerArbitrage}
              arbLoading={arbLoading}
            />
            <ProfitDetermination />
          </>
        )}
        {activeTab === 2 && (
          <Settings
            settings={settings}
            onSettingsSave={handleSaveSettings}
            onStart={startBot}
            onStop={stopBot}
          />
        )}
        {activeTab === 3 && (
          <BotLogs logs={botLogsPage.logs} loadingLogs={loadingLogs} />
        )}
      </Box>
    </Box>
  );
}

export default App;
