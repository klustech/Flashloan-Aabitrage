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
import { getMetrics } from "../services/api";

const Dashboard = () => {
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const data = await getMetrics();
        setMetrics(data);
      } catch (e) {
        console.error("metrics fetch error", e);
      }
    };
    fetchMetrics();
    const id = setInterval(fetchMetrics, 30000);
    return () => clearInterval(id);
  }, []);

  const metricMap = {};
  if (Array.isArray(metrics)) {
    metrics.forEach((m) => {
      if (m.values && m.values.length) {
        metricMap[m.name] = m.values[0].value;
      }
    });
  }

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
              {metricMap["avg_profit_dai"] ?
                metricMap["avg_profit_dai"].toFixed(2) : "-"}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" color="primary">
              Arb Attempts
            </Typography>
            <Typography variant="h4">
              {metricMap["arb_attempts_total"] ?? 0}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" color="primary">
              Execution Time
            </Typography>
            <Typography variant="h4">
              {metricMap["avg_latency_ms"]
                ? `${metricMap["avg_latency_ms"].toFixed(0)} ms`
                : "-"}
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
            <TableRow>
              <TableCell>12:00</TableCell>
              <TableCell>ETH/BTC</TableCell>
              <TableCell>$123.45</TableCell>
            </TableRow>
            {/* Additional rows rendered dynamically */}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
};

export default Dashboard;
