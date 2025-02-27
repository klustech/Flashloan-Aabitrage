// frontend/src/App.js

<<<<<<< HEAD
import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Trades from './pages/Trades'; // Trades page shows open trades
import Settings from './pages/Settings';
import Logs from './pages/Logs';
import Navbar from './components/Navbar';
import './App.css';

function App() {
  return (
    <div className="App">
      <Navbar />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/trades" element={<Trades />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/logs" element={<Logs />} />
      </Routes>
    </div>
=======
import React, { useEffect, useState } from "react";
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
  TextField
} from "@mui/material";
import { Line } from "react-chartjs-2";
import "chart.js/auto";

import DashboardIcon from "@mui/icons-material/Dashboard";
import HistoryIcon from "@mui/icons-material/History";
import SettingsIcon from "@mui/icons-material/Settings";
import BuildIcon from "@mui/icons-material/Build";

import {
  getCurrentPrices,
  triggerArbitrage,
  getBotLogs,
  getSettings,
  updateSettings,
  startBot,
  stopBot
} from "./services/api";

function Dashboard({ prices, marketHistory, loadingPrices }) {
  const chartData = {
    labels: marketHistory.map(entry => entry.time),
    datasets: [
      {
        label: "Uniswap Price (ETH)",
        data: marketHistory.map(entry => entry.uniswapPrice),
        borderColor: "blue",
        fill: false
      },
      {
        label: "SushiSwap Price (ETH)",
        data: marketHistory.map(entry => entry.sushiPrice),
        borderColor: "red",
        fill: false
      }
    ]
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
  const [localSettings, setLocalSettings] = useState({
    flashbotsDefault: settings.flashbotsDefault || false,
    pollingInterval: settings.pollingInterval || 60,
    gasPriceCeiling: settings.gasPriceCeiling || 50,
    slippageBips: settings.slippageBips || 50,
    minBorrowAmount: settings.minBorrowAmount || 100,
    simulationInputAmount: settings.simulationInputAmount || 1000000,
  });
  const [saving, setSaving] = useState(false);

  const handleChange = (e) => {
    if (!e || !e.target) return;
    const { name, value, type, checked } = e.target;
    setLocalSettings((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : Number(value),
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSettingsSave(localSettings);
    } catch (error) {
      console.error("Error saving settings:", error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Typography variant="h5" gutterBottom>
        ⚙️ Bot Settings & Control
      </Typography>
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
            helperText="Set the minimum DAI value for borrowing"
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
            helperText="Set the simulation input amount in DAI"
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
          <Button fullWidth variant="outlined" color="secondary" onClick={onStart}>
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
            border: "1px solid #ccc",
            borderRadius: 1,
            p: 2,
            fontFamily: "monospace",
            whiteSpace: "pre-line",
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
  const [activeTab, setActiveTab] = useState(0);
  const [prices, setPrices] = useState({});
  const [marketHistory, setMarketHistory] = useState([]);
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [botLogs, setBotLogs] = useState([]);
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
      setMarketHistory(prev => [
        ...prev.slice(-9),
        { time: new Date().toLocaleTimeString(), ...data }
      ]);
    } finally {
      setLoadingPrices(false);
    }
  };

  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      const logs = await getBotLogs();
      setBotLogs(logs);
    } finally {
      setLoadingLogs(false);
    }
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
      <AppBar position="static">
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
          <BotControl onTrigger={handleTriggerArbitrage} arbLoading={arbLoading} />
        )}
        {activeTab === 2 && (
          <Settings
            settings={settings}
            onSettingsSave={updateSettings}
            onStart={startBot}
            onStop={stopBot}
          />
        )}
        {activeTab === 3 && <BotLogs logs={botLogs} loadingLogs={loadingLogs} />}
      </Box>
    </Box>
>>>>>>> fb927c21 (Major upgrades since last push)
  );
}

export default App;
