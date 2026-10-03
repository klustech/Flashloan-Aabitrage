import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { PsychologyOutlined, RefreshRounded } from "@mui/icons-material";
import { getMLStats } from "../services/api";
import { EmptyState, Metric, Panel } from "../ui/Primitives";
import { number } from "../ui/format";
const percent = (value) =>
  value == null || !Number.isFinite(Number(value))
    ? "—"
    : `${number(Number(value) * 100, 2)}%`;
export default function MLStatistics() {
  const [stats, setStats] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await getMLStats());
      setError("");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    fetchStats();
    const timer = setInterval(fetchStats, 30000);
    return () => clearInterval(timer);
  }, [fetchStats]);
  const available =
    stats &&
    stats.available !== false &&
    (Number(stats.totalPredictions) > 0 || stats.accuracy != null);
  return (
    <Box sx={{ display: "grid", gap: 3 }}>
      <Alert severity="info">
        ML scores are optional diagnostics. Production quotes, transaction
        simulations and execution guards make trading decisions.
      </Alert>
      <Panel
        title="Model performance"
        subtitle="Metrics reported by the configured model service."
        action={
          <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
            {stats?.modelVersion && (
              <Chip label={stats.modelVersion} variant="outlined" />
            )}
            <Button
              size="small"
              onClick={fetchStats}
              disabled={loading}
              startIcon={<RefreshRounded />}
            >
              Refresh
            </Button>
          </Box>
        }
      >
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {!available ? (
          <EmptyState
            icon={PsychologyOutlined}
            title={
              loading ? "Loading model diagnostics" : "No model results yet"
            }
            description={
              stats?.message ||
              "No configured model has supplied prediction metrics. The production scanner can operate independently."
            }
          />
        ) : (
          <>
            <Box className="dashboard-grid">
              {[
                ["Accuracy", stats.accuracy],
                ["Precision", stats.precision],
                ["Recall", stats.recall],
                ["AUC", stats.auc],
              ].map(([label, value]) => (
                <Metric key={label} label={label} value={percent(value)} />
              ))}
            </Box>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, mt: 3 }}>
              <Typography variant="body2" color="text.secondary">
                Predictions:{" "}
                <Box component="span" sx={{ color: "text.primary" }}>
                  {number(stats.totalPredictions)}
                </Box>
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Correct:{" "}
                <Box component="span" sx={{ color: "text.primary" }}>
                  {number(stats.correctPredictions)}
                </Box>
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Response time:{" "}
                <Box component="span" sx={{ color: "text.primary" }}>
                  {number(stats.avgResponseTime)} ms
                </Box>
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Trained:{" "}
                {stats.lastTrained
                  ? new Date(stats.lastTrained).toLocaleDateString()
                  : "—"}
              </Typography>
            </Box>
          </>
        )}
      </Panel>
      {available && (
        <Box className="dashboard-split">
          <Panel
            title="Feature importance"
            subtitle="Relative contribution reported by the model."
          >
            {stats.featureImportance?.length ? (
              stats.featureImportance.map((item, i) => (
                <Box key={i} sx={{ mb: 2.5 }}>
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      mb: 1,
                    }}
                  >
                    <Typography variant="body2">
                      {item.feature?.replaceAll("_", " ")}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {percent(item.importance)}
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={Math.max(
                      0,
                      Math.min(100, Number(item.importance || 0) * 100)
                    )}
                  />
                </Box>
              ))
            ) : (
              <EmptyState
                compact
                title="No feature breakdown"
                description="Feature contributions have not been supplied."
              />
            )}
          </Panel>
          <Panel
            title="Recent predictions"
            subtitle="Recorded model predictions and observed outcomes."
          >
            {stats.recentPredictions?.length ? (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Score</TableCell>
                      <TableCell>Outcome</TableCell>
                      <TableCell align="right">Reported profit (ETH)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {stats.recentPredictions.map((prediction, i) => (
                      <TableRow key={i}>
                        <TableCell>{percent(prediction.score)}</TableCell>
                        <TableCell>
                          <Chip
                            label={prediction.actual ? "Executed" : "Skipped"}
                            color={prediction.actual ? "success" : "default"}
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell align="right">
                          {number(prediction.profit, 4)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            ) : (
              <EmptyState
                compact
                title="No predictions recorded"
                description="Recent prediction outcomes will appear here."
              />
            )}
          </Panel>
        </Box>
      )}
    </Box>
  );
}
