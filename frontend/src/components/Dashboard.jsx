import React, { useEffect, useState } from "react";
import {
  Box,
  Grid,
  Paper,
  Typography,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Tabs,
  Tab,
  Chip,
  LinearProgress,
} from "@mui/material";
import {
  TrendingUp,
  Speed,
  LocalGasStation,
  Assessment,
} from "@mui/icons-material";
import { getMetrics, getTradeHistory, getDailyStats } from "../services/api";
import RouteVisualization from "./RouteVisualization";
import RealTimeOpportunities from "./RealTimeOpportunities";
import MLStatistics from "./MLStatistics";
import ProfitSimulator from "./ProfitSimulator";
import BotStatus from "./BotStatus";
import ProfitChart from "./ProfitChart";
import TradingControl from "./TradingControl";

const TabPanel = ({ children, value, index }) => (
  <div hidden={value !== index} style={{ paddingTop: 16 }}>
    {value === index && children}
  </div>
);

const Dashboard = ({ adminMode = false }) => {
  const [metrics, setMetrics] = useState(null);
  const [trades, setTrades] = useState([]);
  const [dailyStats, setDailyStats] = useState(null);
  const [tradesLoading, setTradesLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(0);

  useEffect(() => {
    let isMounted = true;

    const fetchMetrics = async () => {
      try {
        const data = await getMetrics();
        if (isMounted) {
          setMetrics(data);
        }
      } catch (e) {
        console.error("metrics fetch error", e);
      }
    };

    const fetchTrades = async () => {
      try {
        const data = await getTradeHistory(10);
        if (isMounted) {
          setTrades(Array.isArray(data) ? data : []);
        }
      } catch (e) {
        console.error("trade history fetch error", e);
        if (isMounted) {
          setTrades([]);
        }
      } finally {
        if (isMounted) {
          setTradesLoading(false);
        }
      }
    };

    const fetchDailyStats = async () => {
      try {
        const data = await getDailyStats();
        if (isMounted) {
          setDailyStats(data);
        }
      } catch (e) {
        console.error("daily stats fetch error", e);
      }
    };

    fetchMetrics();
    fetchTrades();
    fetchDailyStats();

    const id = setInterval(() => {
      fetchMetrics();
      fetchTrades();
      fetchDailyStats();
    }, 30000);

    return () => {
      isMounted = false;
      clearInterval(id);
    };
  }, []);

  const metricMap = {};
  if (Array.isArray(metrics)) {
    metrics.forEach((m) => {
      if (m.values && m.values.length) {
        metricMap[m.name] = m.values[0].value;
      }
    });
  }

  const getNumericMetric = (name) => {
    if (!Object.prototype.hasOwnProperty.call(metricMap, name)) {
      return null;
    }
    if (metricMap[name] === null || metricMap[name] === undefined) return null;
    const parsed = Number(metricMap[name]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const avgProfitDai = getNumericMetric("avg_profit_dai");
  const arbAttemptsTotal = getNumericMetric("arb_attempts_total");
  const avgLatencyMs = getNumericMetric("avg_latency_ms");
  const successRate = getNumericMetric("arb_success_rate") ||
    (dailyStats?.successfulTrades && dailyStats?.totalAttempts
      ? (dailyStats.successfulTrades / dailyStats.totalAttempts) * 100
      : null);

  return (
    <Box sx={{ maxWidth: 1400, mx: "auto", p: 2 }}>
      {/* Header */}
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 3 }}>
        <Typography variant="h4" color="primary">
          Arbitrage Dashboard
          {adminMode && (
            <Chip label="Admin Mode" color="secondary" size="small" sx={{ ml: 2 }} />
          )}
        </Typography>
        <BotStatus compact />
      </Box>

      <TradingControl />

      {/* Top Stats Cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={6} md={3}>
          <Paper sx={{ p: 2, bgcolor: "background.default" }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
              <TrendingUp color="success" />
              <Typography variant="subtitle2" color="text.secondary">
                Expected average profit
              </Typography>
            </Box>
            <Typography variant="h4" color="success.main">
              {avgProfitDai !== null ? `${avgProfitDai.toFixed(4)}` : "-"}
              <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 0.5 }}>
                DAI
              </Typography>
            </Typography>
            {dailyStats?.profitChange && (
              <Typography variant="caption" color={dailyStats.profitChange >= 0 ? "success.main" : "error.main"}>
                {dailyStats.profitChange >= 0 ? "+" : ""}{dailyStats.profitChange.toFixed(2)}% today
              </Typography>
            )}
          </Paper>
        </Grid>

        <Grid item xs={6} md={3}>
          <Paper sx={{ p: 2, bgcolor: "background.default" }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
              <Assessment color="primary" />
              <Typography variant="subtitle2" color="text.secondary">
                Arb Attempts
              </Typography>
            </Box>
            <Typography variant="h4">
              {arbAttemptsTotal !== null ? arbAttemptsTotal.toLocaleString() : "-"}
            </Typography>
            {successRate !== null && (
              <Box sx={{ mt: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  Success Rate: {successRate.toFixed(1)}%
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={successRate}
                  sx={{ mt: 0.5, height: 4, borderRadius: 2 }}
                  color={successRate > 70 ? "success" : successRate > 40 ? "warning" : "error"}
                />
              </Box>
            )}
          </Paper>
        </Grid>

        <Grid item xs={6} md={3}>
          <Paper sx={{ p: 2, bgcolor: "background.default" }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
              <Speed color="info" />
              <Typography variant="subtitle2" color="text.secondary">
                Avg Latency
              </Typography>
            </Box>
            <Typography variant="h4">
              {avgLatencyMs !== null ? `${avgLatencyMs.toFixed(0)}` : "-"}
              <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 0.5 }}>
                ms
              </Typography>
            </Typography>
            <Chip
              label={avgLatencyMs !== null && avgLatencyMs < 500 ? "Fast" : "Normal"}
              size="small"
              color={avgLatencyMs !== null && avgLatencyMs < 500 ? "success" : "default"}
              sx={{ mt: 1 }}
            />
          </Paper>
        </Grid>

        <Grid item xs={6} md={3}>
          <Paper sx={{ p: 2, bgcolor: "background.default" }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
              <LocalGasStation color="warning" />
              <Typography variant="subtitle2" color="text.secondary">
                Gas Spent
              </Typography>
            </Box>
            <Typography variant="h4">
              {dailyStats?.totalGasSpent !== undefined
                ? dailyStats.totalGasSpent.toFixed(4)
                : getNumericMetric("total_gas_spent")?.toFixed(4) || "-"}
              <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 0.5 }}>
                ETH
              </Typography>
            </Typography>
            {dailyStats?.avgGasPrice && (
              <Typography variant="caption" color="text.secondary">
                Avg: {dailyStats.avgGasPrice} gwei
              </Typography>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Main Content Tabs */}
      <Paper sx={{ mb: 3 }}>
        <Tabs
          value={activeTab}
          onChange={(_, newValue) => setActiveTab(newValue)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ borderBottom: 1, borderColor: "divider" }}
        >
          <Tab label="Overview" />
          <Tab label="Route Candidates" />
          <Tab label="Live Opportunities" />
          <Tab label="ML Analytics" />
          <Tab label="Simulator" />
        </Tabs>

        {/* Overview Tab */}
        <TabPanel value={activeTab} index={0}>
          <Box sx={{ p: 2 }}>
            {/* Profit Chart */}
            <Box sx={{ mb: 3 }}>
              <ProfitChart />
            </Box>

            <Grid container spacing={3}>
              {/* Recent Trades */}
              <Grid item xs={12} lg={7}>
                <Typography variant="h6" color="primary" gutterBottom>
                  Recent Trades
                </Typography>
                <Paper sx={{ overflowX: "auto" }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ color: "primary.main" }}>Time</TableCell>
                        <TableCell sx={{ color: "primary.main" }}>Route</TableCell>
                        <TableCell sx={{ color: "primary.main" }}>Profit</TableCell>
                        <TableCell sx={{ color: "primary.main" }}>Status</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {tradesLoading ? (
                        <TableRow>
                          <TableCell colSpan={4}>
                            <LinearProgress />
                          </TableCell>
                        </TableRow>
                      ) : trades.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} sx={{ textAlign: "center", py: 3 }}>
                            No trades recorded yet.
                          </TableCell>
                        </TableRow>
                      ) : (
                        trades.map((trade) => {
                          const profitValue = Number(trade.profit);
                          const profitDisplay = Number.isFinite(profitValue)
                            ? `${profitValue >= 0 ? "+" : ""}${profitValue.toFixed(4)} DAI`
                            : trade.profit || "-";
                          const timestamp = trade.timestamp
                            ? new Date(trade.timestamp).toLocaleString()
                            : "-";
                          return (
                            <TableRow key={`${trade.txHash ?? "trade"}-${trade.timestamp}`}>
                              <TableCell>{timestamp}</TableCell>
                              <TableCell>
                                <Typography variant="body2" noWrap sx={{ maxWidth: 200 }}>
                                  {trade.route || "-"}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography
                                  variant="body2"
                                  color={profitValue >= 0 ? "success.main" : "error.main"}
                                >
                                  {profitDisplay}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Chip
                                  label={trade.status || "completed"}
                                  size="small"
                                  color={
                                    trade.status === "success" || trade.status === "completed"
                                      ? "success"
                                      : trade.status === "failed"
                                      ? "error"
                                      : "default"
                                  }
                                />
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </Paper>
              </Grid>

              {/* Quick Stats */}
              <Grid item xs={12} lg={5}>
                <BotStatus />
              </Grid>
            </Grid>
          </Box>
        </TabPanel>

        {/* Route Candidates Tab */}
        <TabPanel value={activeTab} index={1}>
          <Box sx={{ p: 2 }}>
            <RouteVisualization />
          </Box>
        </TabPanel>

        {/* Live Opportunities Tab */}
        <TabPanel value={activeTab} index={2}>
          <Box sx={{ p: 2 }}>
            <RealTimeOpportunities />
          </Box>
        </TabPanel>

        {/* ML Analytics Tab */}
        <TabPanel value={activeTab} index={3}>
          <Box sx={{ p: 2 }}>
            <MLStatistics />
          </Box>
        </TabPanel>

        {/* Simulator Tab */}
        <TabPanel value={activeTab} index={4}>
          <Box sx={{ p: 2 }}>
            <ProfitSimulator />
          </Box>
        </TabPanel>
      </Paper>
    </Box>
  );
};

export default Dashboard;

