import React, { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  TextField,
  Typography,
} from "@mui/material";
import { RefreshRounded, SaveOutlined, StopRounded } from "@mui/icons-material";
import {
  getBotStatus,
  getMetrics,
  getSettings,
  stopBot,
  updateSettings,
} from "../services/api";
import {
  settingsUpdateSchema,
  pickSettingsFields,
  normalizeFieldErrors,
} from "../validation/settingsSchema";
import { useTradingStatus } from "../hooks/useTradingStatus";
import { EmptyState, Panel, StatusBadge } from "../ui/Primitives";
import { number, time } from "../ui/format";
const FIELDS = [
  ["gasPriceCeiling", "Gas price ceiling", "gwei", 1, 1000000],
  ["slippageBips", "Slippage tolerance", "basis points · 100 bps = 1%", 0, 500],
  ["minBorrowAmount", "Minimum borrow amount", "borrow-token units", 1],
  [
    "simulationInputAmount",
    "Legacy simulation input",
    "token units · manual simulation only",
    1,
  ],
  [
    "pollingInterval",
    "Legacy polling interval",
    "seconds · production scans on new blocks",
    5,
    3600,
  ],
];
export default function BotStatus({ compact = false }) {
  const { status, refresh } = useTradingStatus();
  const [health, setHealth] = useState(null),
    [metrics, setMetrics] = useState([]),
    [settings, setSettings] = useState(null),
    [fieldErrors, setFieldErrors] = useState({}),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (compact) return undefined;
    let mounted = true;
    const load = async () => {
      const values = await Promise.allSettled([
        getBotStatus(),
        getMetrics(),
        getSettings(),
      ]);
      if (!mounted) return;
      if (values[0].status === "fulfilled") setHealth(values[0].value);
      if (values[1].status === "fulfilled")
        setMetrics(Array.isArray(values[1].value) ? values[1].value : []);
      if (values[2].status === "fulfilled") setSettings(values[2].value);
      if (values.some((v) => v.status === "rejected"))
        setError(
          "Some system details could not be loaded. Trading state remains available above."
        );
    };
    load();
    return () => {
      mounted = false;
    };
  }, [compact]);
  const reload = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const [h, s, m] = await Promise.all([
        getBotStatus(),
        getSettings(),
        getMetrics(),
      ]);
      setHealth(h);
      setSettings(s);
      setMetrics(Array.isArray(m) ? m : []);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };
  const save = async (event) => {
    event.preventDefault();
    setFieldErrors({});
    setError("");
    setNotice("");
    const parsed = settingsUpdateSchema.safeParse(pickSettingsFields(settings));
    if (!parsed.success) {
      setFieldErrors(normalizeFieldErrors(parsed.error.flatten().fieldErrors));
      return;
    }
    setBusy(true);
    try {
      const response = await updateSettings(parsed.data);
      setSettings(response.settings);
      setNotice("Settings saved. Configured production ceilings still apply.");
      await refresh({ afterCurrent: true });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    setError("");
    try {
      await stopBot();
      await refresh({ afterCurrent: true });
      setNotice("Scanner stopped. Submitted receipts remain tracked.");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };
  if (compact) return <StatusBadge value={status?.trading?.state} />;
  return (
    <Box sx={{ display: "grid", gap: 3 }}>
      {error && <Alert severity="warning">{error}</Alert>}
      {notice && (
        <Alert severity="success" onClose={() => setNotice("")}>
          {notice}
        </Alert>
      )}
      <Box className="dashboard-split">
        <Panel
          title="System status"
          subtitle="Reported API health and scanner state. Live readiness is checked separately."
          action={
            <Button
              size="small"
              startIcon={<RefreshRounded />}
              onClick={reload}
              disabled={busy}
            >
              Reload
            </Button>
          }
        >
          <Box sx={{ display: "grid", gap: 2.2 }}>
            {[
              ["Trading state", status?.trading?.state],
              ["Last worker run", time(health?.lastRunAt)],
              ["Last successful cycle", time(health?.lastSuccessAt)],
              ["Circuit breaker", health?.circuitBreaker?.state],
              [
                "Consecutive failures",
                number(health?.circuitBreaker?.consecutiveFailures),
              ],
              ["Pending receipts", number(status?.summary?.pending)],
            ].map(([label, value]) => (
              <Box
                key={label}
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 2,
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  {label}
                </Typography>
                <Typography variant="body2">{value || "—"}</Typography>
              </Box>
            ))}
          </Box>
          {health?.lastErrorMessage && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {health.lastErrorMessage}
            </Alert>
          )}
          <Divider sx={{ my: 2.5 }} />
          <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
            Service reports
          </Typography>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            {[
              ["Database", health?.services?.database],
              ["ML service", health?.services?.mlService],
              ["Timelock", health?.services?.timelock],
            ].map(([label, value]) => (
              <Chip
                key={label}
                variant="outlined"
                label={`${label}: ${
                  value === true
                    ? "reported available"
                    : value === false
                    ? "reported unavailable"
                    : "unknown"
                }`}
                color={value === true ? "info" : "default"}
              />
            ))}
          </Box>
          <Button
            variant="outlined"
            color="warning"
            startIcon={<StopRounded />}
            onClick={stop}
            disabled={busy || !status || status.trading?.state === "STOPPED"}
            sx={{ mt: 3 }}
          >
            Stop scanner
          </Button>
        </Panel>
        <Panel
          title="PAPER commissioning"
          subtitle="Continuity evidence for this configured profile."
        >
          <Typography variant="h5" sx={{ mb: 1 }}>
            {status?.paperBurnIn?.passed
              ? "Evidence passed"
              : "Evidence in progress"}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            At least seven continuous days and a complete profitable simulation
            are required. Profile changes or long heartbeat gaps restart
            continuity.
          </Typography>
          <Box sx={{ mt: 3, display: "grid", gap: 2 }}>
            {[
              ["Recorded simulations", number(status?.paperBurnIn?.simulated)],
              [
                "Window started",
                status?.paperBurnIn?.startedAt
                  ? new Date(status.paperBurnIn.startedAt).toLocaleString()
                  : "—",
              ],
              ["Last heartbeat", time(status?.paperBurnIn?.lastHeartbeat)],
              [
                "Readiness",
                status?.readiness
                  ? status.readiness.ready
                    ? "Checks passed"
                    : "Checks outstanding"
                  : "Not checked",
              ],
            ].map(([label, value]) => (
              <Box key={label}>
                <Typography variant="caption" color="text.secondary">
                  {label}
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.3 }}>
                  {value}
                </Typography>
              </Box>
            ))}
          </Box>
        </Panel>
      </Box>
      <Panel
        title="Operator settings"
        subtitle="Changes are validated by the API and remain subject to configured production limits."
      >
        {settings ? (
          <Box component="form" onSubmit={save}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: {
                  xs: "1fr",
                  md: "repeat(2,minmax(0,1fr))",
                  xl: "repeat(3,minmax(0,1fr))",
                },
                gap: 3,
              }}
            >
              {FIELDS.map(([key, label, hint, min, max]) => (
                <TextField
                  key={key}
                  fullWidth
                  label={label}
                  type="number"
                  size="small"
                  value={settings[key] ?? ""}
                  onChange={(event) =>
                    setSettings({ ...settings, [key]: event.target.value })
                  }
                  error={Boolean(fieldErrors[key])}
                  helperText={fieldErrors[key] || hint}
                  inputProps={{ min, max, step: 1 }}
                />
              ))}
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              Production execution uses private relays and block-driven
              scheduling. Legacy simulation and polling settings do not change
              those rules.
            </Typography>
            <Box sx={{ display: "flex", gap: 1.5, mt: 3 }}>
              <Button
                type="submit"
                variant="contained"
                startIcon={<SaveOutlined />}
                disabled={busy}
              >
                {busy ? "Saving…" : "Save settings"}
              </Button>
              <Button onClick={reload} disabled={busy}>
                Reload saved settings
              </Button>
            </Box>
          </Box>
        ) : (
          <EmptyState
            compact
            title="Settings unavailable"
            description="Reload when the settings API is reachable. No placeholder values will be saved."
          />
        )}
      </Panel>
      <Panel
        title="Diagnostics"
        subtitle="Reported Prometheus metrics, for operator inspection."
      >
        {metrics.length ? (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", md: "repeat(3,minmax(0,1fr))" },
              gap: 2,
            }}
          >
            {metrics
              .filter((m) =>
                [
                  "avg_profit_dai",
                  "avg_latency_ms",
                  "arb_attempts_total",
                  "arb_success_rate",
                  "total_gas_spent",
                ].includes(m.name)
              )
              .map((metric) => (
                <Box
                  key={metric.name}
                  sx={{ p: 2, bgcolor: "background.default", borderRadius: 2 }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {metric.name.replaceAll("_", " ")}
                  </Typography>
                  <Typography variant="h6">
                    {number(metric.values?.[0]?.value, 4)}
                  </Typography>
                </Box>
              ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No diagnostic metrics received.
          </Typography>
        )}
      </Panel>
    </Box>
  );
}
