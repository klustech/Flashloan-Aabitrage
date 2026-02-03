import React, { useEffect, useState } from "react";
import {
  Box,
  Grid,
  Paper,
  Typography,
  CircularProgress,
} from "@mui/material";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { getTradeHistory, getMetrics } from "../services/api";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const StatCard = ({ title, value, unit, color, subtitle }) => (
  <Paper sx={{ p: 2, height: "100%" }}>
    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
      {title}
    </Typography>
    <Typography variant="h4" sx={{ color: color || "primary.main" }}>
      {value}
      {unit && (
        <Typography component="span" variant="body1" color="text.secondary">
          {" "}{unit}
        </Typography>
      )}
    </Typography>
    {subtitle && (
      <Typography variant="caption" color="text.secondary">
        {subtitle}
      </Typography>
    )}
  </Paper>
);

const TradeStats = () => {
  const [trades, setTrades] = useState([]);
  const [metrics, setMetrics] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [tradesData, metricsData] = await Promise.all([
          getTradeHistory(100),
          getMetrics(),
        ]);
        setTrades(Array.isArray(tradesData) ? tradesData : []);

        // Parse metrics
        const metricsMap = {};
        if (Array.isArray(metricsData)) {
          metricsData.forEach((m) => {
            if (m.values && m.values.length) {
              metricsMap[m.name] = m.values[0].value;
            }
          });
        }
        setMetrics(metricsMap);
      } catch (err) {
        console.error("Failed to fetch trade stats:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  // Calculate statistics
  const totalProfit = trades.reduce((sum, t) => {
    const profit = Number(t.profit);
    return sum + (Number.isFinite(profit) ? profit : 0);
  }, 0);

  const successfulTrades = trades.filter((t) => t.status === "success" || Number(t.profit) > 0);
  const winRate = trades.length > 0 ? (successfulTrades.length / trades.length) * 100 : 0;

  const avgProfit = successfulTrades.length > 0
    ? successfulTrades.reduce((sum, t) => sum + Number(t.profit || 0), 0) / successfulTrades.length
    : 0;

  const largestProfit = trades.reduce((max, t) => {
    const profit = Number(t.profit);
    return profit > max ? profit : max;
  }, 0);

  // Prepare chart data - cumulative profit over time
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  let cumulative = 0;
  const chartData = {
    labels: sortedTrades.map((t) =>
      new Date(t.timestamp).toLocaleDateString()
    ),
    datasets: [
      {
        label: "Cumulative Profit (DAI)",
        data: sortedTrades.map((t) => {
          cumulative += Number(t.profit || 0);
          return cumulative;
        }),
        borderColor: "rgb(75, 192, 192)",
        backgroundColor: "rgba(75, 192, 192, 0.1)",
        fill: true,
        tension: 0.4,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    plugins: {
      legend: {
        display: false,
      },
      title: {
        display: true,
        text: "Cumulative Profit Over Time",
      },
    },
    scales: {
      y: {
        beginAtZero: true,
      },
    },
  };

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" color="primary" gutterBottom>
        Trading Statistics
      </Typography>

      <Grid container spacing={2} mb={3}>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Total Profit"
            value={totalProfit.toFixed(2)}
            unit="DAI"
            color={totalProfit >= 0 ? "success.main" : "error.main"}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Total Trades"
            value={trades.length}
            subtitle={`${successfulTrades.length} successful`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Win Rate"
            value={winRate.toFixed(1)}
            unit="%"
            color={winRate >= 50 ? "success.main" : "warning.main"}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Avg Profit/Trade"
            value={avgProfit.toFixed(4)}
            unit="DAI"
          />
        </Grid>
      </Grid>

      <Grid container spacing={2} mb={3}>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Largest Profit"
            value={largestProfit.toFixed(4)}
            unit="DAI"
            color="success.main"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Arb Attempts"
            value={metrics.arb_attempts_total || "0"}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Avg Latency"
            value={Number(metrics.avg_latency_ms || 0).toFixed(0)}
            unit="ms"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Gas Price"
            value={Number(metrics.gas_price_gwei || 0).toFixed(1)}
            unit="Gwei"
          />
        </Grid>
      </Grid>

      <Paper sx={{ p: 2 }}>
        {trades.length > 0 ? (
          <Line data={chartData} options={chartOptions} />
        ) : (
          <Typography color="text.secondary" sx={{ textAlign: "center", py: 4 }}>
            No trade data available for chart.
          </Typography>
        )}
      </Paper>
    </Box>
  );
};

export default TradeStats;
