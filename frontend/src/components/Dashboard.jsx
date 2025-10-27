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
} from "@mui/material";
import { getMetrics, getTradeHistory } from "../services/api";

const Dashboard = () => {
  const [metrics, setMetrics] = useState(null);
  const [trades, setTrades] = useState([]);
  const [tradesLoading, setTradesLoading] = useState(true);

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
    fetchMetrics();
    fetchTrades();
    const id = setInterval(() => {
      fetchMetrics();
      fetchTrades();
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

    const parsed = Number(metricMap[name]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const avgProfitDai = getNumericMetric("avg_profit_dai");
  const arbAttemptsTotal = getNumericMetric("arb_attempts_total");
  const avgLatencyMs = getNumericMetric("avg_latency_ms");

  return (
    <Box sx={{ maxWidth: 1200, mx: "auto", p: 2 }}>
      <Typography variant="h4" color="primary" gutterBottom>
        Dashboard
      </Typography>
      <Grid container spacing={2} mb={4}>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" color="primary">
              Total Profit
            </Typography>
            <Typography variant="h4">
              {avgProfitDai !== null ? avgProfitDai.toFixed(2) : "-"}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" color="primary">
              Arb Attempts
            </Typography>
            <Typography variant="h4">
              {arbAttemptsTotal !== null ? arbAttemptsTotal : "-"}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" color="primary">
              Execution Time
            </Typography>
            <Typography variant="h4">
              {avgLatencyMs !== null ? `${avgLatencyMs.toFixed(0)} ms` : "-"}
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      <Typography variant="h6" color="primary" gutterBottom>
        Recent Trades
      </Typography>
      <Paper sx={{ overflowX: "auto" }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ color: "primary.main" }}>Time</TableCell>
              <TableCell sx={{ color: "primary.main" }}>Asset</TableCell>
              <TableCell sx={{ color: "primary.main" }}>Profit</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {tradesLoading ? (
              <TableRow>
                <TableCell colSpan={3}>Loading trade history…</TableCell>
              </TableRow>
            ) : trades.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3}>No trades recorded yet.</TableCell>
              </TableRow>
            ) : (
              trades.map((trade) => {
                const profitValue = Number(trade.profit);
                const profitDisplay = Number.isFinite(profitValue)
                  ? `${profitValue.toFixed(4)} DAI`
                  : trade.profit || "-";
                const timestamp = trade.timestamp
                  ? new Date(trade.timestamp).toLocaleString()
                  : "-";
                return (
                  <TableRow key={`${trade.txHash ?? "trade"}-${trade.timestamp}`}>
                    <TableCell>{timestamp}</TableCell>
                    <TableCell>{trade.route || trade.status || "-"}</TableCell>
                    <TableCell>{profitDisplay}</TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
};

export default Dashboard;
