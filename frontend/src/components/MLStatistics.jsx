import React, { useState, useEffect } from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  LinearProgress,
  Chip,
  Tooltip,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  CircularProgress,
} from "@mui/material";
import {
  TrendingUp,
  TrendingDown,
  Psychology,
  Speed,
  CheckCircle,
  Cancel,
  Refresh,
  Info,
} from "@mui/icons-material";
import { getMLStats } from "../services/api";

const MLStatistics = () => {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const data = await getMLStats();
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to fetch ML statistics");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const formatPercentage = (value) => {
    if (value === null || value === undefined) return "N/A";
    return `${(value * 100).toFixed(2)}%`;
  };

  const getScoreColor = (score) => {
    if (score >= 0.8) return "success";
    if (score >= 0.6) return "warning";
    return "error";
  };

  if (loading && !stats) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            ML Model Statistics
          </Typography>
          <LinearProgress />
        </CardContent>
      </Card>
    );
  }

  // Check if ML model is available and has data
  const isMLAvailable = stats?.available !== false;
  const hasData = stats?.totalPredictions > 0 || stats?.accuracy !== null;

  // Show not available state
  if (!isMLAvailable || (!hasData && !loading)) {
    return (
      <Card>
        <CardContent>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 2 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Psychology color="disabled" />
              <Typography variant="h6">ML Model Statistics</Typography>
            </Box>
            <IconButton onClick={fetchStats} size="small" disabled={loading}>
              <Refresh />
            </IconButton>
          </Box>
          <Paper sx={{ p: 3, textAlign: "center", bgcolor: "background.default" }}>
            <Psychology sx={{ fontSize: 48, opacity: 0.3, mb: 2 }} />
            <Typography variant="body1" color="text.secondary" gutterBottom>
              {stats?.message || "ML model not configured or no predictions yet"}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Configure ML_MODEL_ENDPOINT environment variable to enable ML scoring
            </Typography>
          </Paper>
        </CardContent>
      </Card>
    );
  }

  // Use API data with safe defaults
  const displayStats = {
    modelVersion: stats?.modelVersion || "unknown",
    lastTrained: stats?.lastTrained || new Date().toISOString(),
    accuracy: stats?.accuracy ?? null,
    precision: stats?.precision ?? null,
    recall: stats?.recall ?? null,
    f1Score: stats?.f1Score ?? null,
    auc: stats?.auc ?? null,
    totalPredictions: stats?.totalPredictions || 0,
    correctPredictions: stats?.correctPredictions || 0,
    avgResponseTime: stats?.avgResponseTime || 0,
    featureImportance: stats?.featureImportance || [],
    recentPredictions: stats?.recentPredictions || [],
  };

  return (
    <Card>
      <CardContent>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 2 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Psychology color="primary" />
            <Typography variant="h6">ML Model Statistics</Typography>
          </Box>
          <Box>
            <Chip
              label={displayStats.modelVersion}
              size="small"
              color="primary"
              variant="outlined"
              sx={{ mr: 1 }}
            />
            <IconButton onClick={fetchStats} size="small" disabled={loading}>
              <Refresh />
            </IconButton>
          </Box>
        </Box>

        {error && (
          <Typography color="error" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}

        {/* Model Performance Metrics */}
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={6} sm={3}>
            <Paper sx={{ p: 2, textAlign: "center", bgcolor: "background.default" }}>
              <Typography variant="caption" color="text.secondary">
                Accuracy
              </Typography>
              <Typography variant="h5" color="success.main">
                {formatPercentage(displayStats.accuracy)}
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={6} sm={3}>
            <Paper sx={{ p: 2, textAlign: "center", bgcolor: "background.default" }}>
              <Typography variant="caption" color="text.secondary">
                Precision
              </Typography>
              <Typography variant="h5" color="info.main">
                {formatPercentage(displayStats.precision)}
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={6} sm={3}>
            <Paper sx={{ p: 2, textAlign: "center", bgcolor: "background.default" }}>
              <Typography variant="caption" color="text.secondary">
                Recall
              </Typography>
              <Typography variant="h5" color="warning.main">
                {formatPercentage(displayStats.recall)}
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={6} sm={3}>
            <Paper sx={{ p: 2, textAlign: "center", bgcolor: "background.default" }}>
              <Tooltip title="Area Under ROC Curve">
                <Typography variant="caption" color="text.secondary">
                  AUC-ROC
                </Typography>
              </Tooltip>
              <Typography variant="h5" color="primary.main">
                {formatPercentage(displayStats.auc)}
              </Typography>
            </Paper>
          </Grid>
        </Grid>

        {/* Prediction Stats */}
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={12} sm={6}>
            <Paper sx={{ p: 2, bgcolor: "background.default" }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Total Predictions
                  </Typography>
                  <Typography variant="h6">{displayStats.totalPredictions.toLocaleString()}</Typography>
                </Box>
                <Box sx={{ textAlign: "right" }}>
                  <Typography variant="caption" color="text.secondary">
                    Correct
                  </Typography>
                  <Typography variant="h6" color="success.main">
                    {displayStats.correctPredictions.toLocaleString()}
                  </Typography>
                </Box>
              </Box>
              <LinearProgress
                variant="determinate"
                value={(displayStats.correctPredictions / displayStats.totalPredictions) * 100}
                sx={{ mt: 1, height: 8, borderRadius: 4 }}
                color="success"
              />
            </Paper>
          </Grid>
          <Grid item xs={12} sm={6}>
            <Paper sx={{ p: 2, bgcolor: "background.default" }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Avg Response Time
                  </Typography>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    <Speed fontSize="small" color="primary" />
                    <Typography variant="h6">{displayStats.avgResponseTime}ms</Typography>
                  </Box>
                </Box>
                <Chip
                  label={displayStats.avgResponseTime < 100 ? "Fast" : "Normal"}
                  size="small"
                  color={displayStats.avgResponseTime < 100 ? "success" : "warning"}
                />
              </Box>
            </Paper>
          </Grid>
        </Grid>

        {/* Feature Importance */}
        <Typography variant="subtitle2" gutterBottom sx={{ mt: 2 }}>
          Feature Importance
        </Typography>
        <Box sx={{ mb: 3 }}>
          {displayStats.featureImportance.map((item, idx) => (
            <Box key={idx} sx={{ mb: 1 }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
                <Typography variant="caption">{item.feature.replace(/_/g, " ")}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatPercentage(item.importance)}
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={item.importance * 100}
                sx={{ height: 6, borderRadius: 3 }}
              />
            </Box>
          ))}
        </Box>

        {/* Recent Predictions */}
        <Typography variant="subtitle2" gutterBottom>
          Recent Predictions
        </Typography>
        <TableContainer component={Paper} sx={{ maxHeight: 200 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Score</TableCell>
                <TableCell align="center">Outcome</TableCell>
                <TableCell align="right">Profit (ETH)</TableCell>
                <TableCell align="center">Correct</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {displayStats.recentPredictions.map((pred, idx) => (
                <TableRow key={idx}>
                  <TableCell>
                    <Chip
                      label={`${(pred.score * 100).toFixed(0)}%`}
                      size="small"
                      color={getScoreColor(pred.score)}
                    />
                  </TableCell>
                  <TableCell align="center">
                    {pred.actual ? (
                      <Chip label="Executed" size="small" color="success" variant="outlined" />
                    ) : (
                      <Chip label="Skipped" size="small" color="default" variant="outlined" />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {pred.profit > 0 ? (
                      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                        <TrendingUp fontSize="small" color="success" />
                        <Typography variant="body2" color="success.main" sx={{ ml: 0.5 }}>
                          +{pred.profit.toFixed(4)}
                        </Typography>
                      </Box>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        -
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="center">
                    {(pred.score >= 0.5 && pred.actual) || (pred.score < 0.5 && !pred.actual) ? (
                      <CheckCircle fontSize="small" color="success" />
                    ) : (
                      <Cancel fontSize="small" color="error" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>

        {/* Last Updated */}
        <Box sx={{ mt: 2, textAlign: "right" }}>
          <Typography variant="caption" color="text.secondary">
            Model trained: {new Date(displayStats.lastTrained).toLocaleDateString()}
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
};

export default MLStatistics;
