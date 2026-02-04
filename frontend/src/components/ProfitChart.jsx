import React, { useState, useEffect, useMemo } from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  Grid,
  Paper,
  Skeleton,
  Chip,
} from "@mui/material";
import {
  TrendingUp,
  TrendingDown,
  ShowChart,
  BarChart as BarChartIcon,
} from "@mui/icons-material";
import { getTradeHistory, getDailyStats, getMetrics } from "../services/api";

// Simple sparkline component without external charting library
const Sparkline = ({ data, color = "#4caf50", height = 50 }) => {
  if (!data || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data.map((val, i) => {
    const x = (i / (data.length - 1)) * 100;
    const y = 100 - ((val - min) / range) * 100;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg width="100%" height={height} viewBox="0 0 100 100" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

// Bar chart component
const BarChart = ({ data, color = "#4caf50", height = 100 }) => {
  if (!data || data.length === 0) return null;

  const maxVal = Math.max(...data.map((d) => Math.abs(d.value)));

  return (
    <Box sx={{ display: "flex", alignItems: "flex-end", height, gap: 0.5 }}>
      {data.map((item, i) => {
        const barHeight = maxVal ? (Math.abs(item.value) / maxVal) * height : 0;
        const isPositive = item.value >= 0;

        return (
          <Box
            key={i}
            sx={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <Box
              sx={{
                width: "100%",
                height: barHeight,
                bgcolor: isPositive ? "success.main" : "error.main",
                borderRadius: "2px 2px 0 0",
                opacity: 0.8,
                transition: "height 0.3s ease",
                "&:hover": {
                  opacity: 1,
                },
              }}
              title={`${item.label}: ${item.value.toFixed(4)} DAI`}
            />
            <Typography
              variant="caption"
              sx={{
                fontSize: "0.6rem",
                color: "text.secondary",
                mt: 0.5,
                writingMode: "vertical-lr",
                transform: "rotate(180deg)",
              }}
            >
              {item.label}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
};

const ProfitChart = () => {
  const [trades, setTrades] = useState([]);
  const [dailyStats, setDailyStats] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState("7d");
  const [chartType, setChartType] = useState("line");

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [tradesData, statsData, metricsData] = await Promise.all([
          getTradeHistory(100),
          getDailyStats(),
          getMetrics(),
        ]);
        setTrades(Array.isArray(tradesData) ? tradesData : []);
        setDailyStats(statsData);
        setMetrics(metricsData);
      } catch (e) {
        console.error("Error fetching profit data:", e);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, []);

  // Process trades into daily profit data
  const profitData = useMemo(() => {
    if (!trades.length) return { daily: [], cumulative: [], total: 0 };

    const now = new Date();
    const ranges = {
      "24h": 1,
      "7d": 7,
      "30d": 30,
      all: 365,
    };
    const daysBack = ranges[timeRange] || 7;
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - daysBack);

    // Group by day
    const dailyMap = new Map();
    let runningTotal = 0;

    trades
      .filter((t) => new Date(t.timestamp) >= startDate)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .forEach((trade) => {
        const date = new Date(trade.timestamp).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        const profit = parseFloat(trade.profit) || 0;

        if (!dailyMap.has(date)) {
          dailyMap.set(date, { profit: 0, trades: 0 });
        }
        dailyMap.get(date).profit += profit;
        dailyMap.get(date).trades += 1;
        runningTotal += profit;
      });

    const daily = Array.from(dailyMap.entries()).map(([label, data]) => ({
      label,
      value: data.profit,
      trades: data.trades,
    }));

    // Calculate cumulative
    let cumSum = 0;
    const cumulative = daily.map((d) => {
      cumSum += d.value;
      return cumSum;
    });

    return { daily, cumulative, total: runningTotal };
  }, [trades, timeRange]);

  // Calculate stats
  const stats = useMemo(() => {
    const { daily, total } = profitData;
    if (!daily.length) return null;

    const values = daily.map((d) => d.value);
    const positives = values.filter((v) => v > 0);
    const negatives = values.filter((v) => v < 0);

    return {
      totalProfit: total,
      avgDaily: total / daily.length,
      bestDay: Math.max(...values),
      worstDay: Math.min(...values),
      winningDays: positives.length,
      losingDays: negatives.length,
      winRate: (positives.length / daily.length) * 100,
      totalTrades: daily.reduce((sum, d) => sum + d.trades, 0),
    };
  }, [profitData]);

  if (loading) {
    return (
      <Card>
        <CardContent>
          <Skeleton variant="text" width="40%" height={32} />
          <Skeleton variant="rectangular" height={200} sx={{ mt: 2 }} />
          <Grid container spacing={2} sx={{ mt: 2 }}>
            {[1, 2, 3, 4].map((i) => (
              <Grid item xs={6} sm={3} key={i}>
                <Skeleton variant="rectangular" height={60} />
              </Grid>
            ))}
          </Grid>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        {/* Header */}
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 2 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <ShowChart color="primary" />
            <Typography variant="h6">Profit History</Typography>
          </Box>
          <Box sx={{ display: "flex", gap: 1 }}>
            <ToggleButtonGroup
              value={chartType}
              exclusive
              onChange={(_, val) => val && setChartType(val)}
              size="small"
            >
              <ToggleButton value="line">
                <ShowChart fontSize="small" />
              </ToggleButton>
              <ToggleButton value="bar">
                <BarChartIcon fontSize="small" />
              </ToggleButton>
            </ToggleButtonGroup>
            <ToggleButtonGroup
              value={timeRange}
              exclusive
              onChange={(_, val) => val && setTimeRange(val)}
              size="small"
            >
              <ToggleButton value="24h">24h</ToggleButton>
              <ToggleButton value="7d">7d</ToggleButton>
              <ToggleButton value="30d">30d</ToggleButton>
              <ToggleButton value="all">All</ToggleButton>
            </ToggleButtonGroup>
          </Box>
        </Box>

        {/* Chart */}
        <Paper sx={{ p: 2, bgcolor: "background.default", mb: 3 }}>
          {profitData.daily.length > 0 ? (
            chartType === "line" ? (
              <Box sx={{ height: 150 }}>
                <Sparkline
                  data={profitData.cumulative}
                  color={profitData.total >= 0 ? "#4caf50" : "#f44336"}
                  height={150}
                />
              </Box>
            ) : (
              <BarChart data={profitData.daily} height={150} />
            )
          ) : (
            <Box sx={{ height: 150, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Typography color="text.secondary">No trade data available for this period</Typography>
            </Box>
          )}
        </Paper>

        {/* Stats Grid */}
        {stats && (
          <Grid container spacing={2}>
            <Grid item xs={6} sm={3}>
              <Paper sx={{ p: 1.5, textAlign: "center", bgcolor: "background.default" }}>
                <Typography variant="caption" color="text.secondary">
                  Total Profit
                </Typography>
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 0.5 }}>
                  {stats.totalProfit >= 0 ? (
                    <TrendingUp color="success" fontSize="small" />
                  ) : (
                    <TrendingDown color="error" fontSize="small" />
                  )}
                  <Typography
                    variant="h6"
                    color={stats.totalProfit >= 0 ? "success.main" : "error.main"}
                  >
                    {stats.totalProfit >= 0 ? "+" : ""}
                    {stats.totalProfit.toFixed(4)}
                  </Typography>
                </Box>
                <Typography variant="caption" color="text.secondary">
                  DAI
                </Typography>
              </Paper>
            </Grid>

            <Grid item xs={6} sm={3}>
              <Paper sx={{ p: 1.5, textAlign: "center", bgcolor: "background.default" }}>
                <Typography variant="caption" color="text.secondary">
                  Win Rate
                </Typography>
                <Typography
                  variant="h6"
                  color={stats.winRate >= 50 ? "success.main" : "warning.main"}
                >
                  {stats.winRate.toFixed(1)}%
                </Typography>
                <Chip
                  label={`${stats.winningDays}W / ${stats.losingDays}L`}
                  size="small"
                  sx={{ mt: 0.5 }}
                />
              </Paper>
            </Grid>

            <Grid item xs={6} sm={3}>
              <Paper sx={{ p: 1.5, textAlign: "center", bgcolor: "background.default" }}>
                <Typography variant="caption" color="text.secondary">
                  Best Day
                </Typography>
                <Typography variant="h6" color="success.main">
                  +{stats.bestDay.toFixed(4)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  DAI
                </Typography>
              </Paper>
            </Grid>

            <Grid item xs={6} sm={3}>
              <Paper sx={{ p: 1.5, textAlign: "center", bgcolor: "background.default" }}>
                <Typography variant="caption" color="text.secondary">
                  Total Trades
                </Typography>
                <Typography variant="h6">{stats.totalTrades}</Typography>
                <Typography variant="caption" color="text.secondary">
                  Avg {stats.avgDaily.toFixed(4)}/day
                </Typography>
              </Paper>
            </Grid>
          </Grid>
        )}

        {/* Daily breakdown hint */}
        <Box sx={{ mt: 2, textAlign: "center" }}>
          <Typography variant="caption" color="text.secondary">
            {chartType === "line" ? "Cumulative profit over time" : "Daily profit/loss breakdown"}
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
};

export default ProfitChart;
