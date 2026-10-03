import React, { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
} from "@mui/material";
import {
  PlayArrowRounded,
  PauseRounded,
  ShieldOutlined,
  RadioButtonCheckedRounded,
} from "@mui/icons-material";
import { API } from "../services/api";
import { useTradingStatus } from "../hooks/useTradingStatus";
import { Panel, StatusBadge } from "../ui/Primitives";
import ExecutionHistory from "./ExecutionHistory";
export default function TradingControl({ compact = false }) {
  const { status, error, stale, refresh } = useTradingStatus();
  const [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState(""),
    [readinessOpen, setReadinessOpen] = useState(false),
    [readiness, setReadiness] = useState(null),
    [checking, setChecking] = useState(false);
  const paperOnly = status?.safety?.paperOnly || status?.trading?.paperOnly;
  const state = status?.trading?.state || "UNAVAILABLE",
    live = state === "LIVE_RUNNING";
  const action = async (name) => {
    setBusy(true);
    setActionError("");
    try {
      await API.post(`/api/trading/${name}`);
      await refresh({ afterCurrent: true });
    } catch (e) {
      setActionError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };
  const inspectReadiness = async () => {
    setReadinessOpen(true);
    setChecking(true);
    setReadiness(null);
    try {
      const response = await API.get("/api/trading/readiness");
      setReadiness(response.data);
    } catch (e) {
      setReadiness({
        ready: false,
        errors: [e.response?.data?.error || e.message],
      });
    } finally {
      setChecking(false);
    }
  };
  const armed =
    state === "LIVE_ARMED" &&
    status?.trading?.armed &&
    status.trading.armedUntil > Date.now();
  return (
    <Box sx={{ mb: compact ? 3 : 0 }}>
      <Panel
        sx={{
          p: { xs: 2, md: 2.5 },
          borderColor: live ? "error.main" : "divider",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 2,
            flexWrap: "wrap",
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.5,
              flexWrap: "wrap",
              minWidth: 0,
            }}
          >
            <Box
              sx={{
                display: "grid",
                placeItems: "center",
                width: 40,
                height: 40,
                borderRadius: 2,
                bgcolor: "#7ce9bf10",
              }}
            >
              <RadioButtonCheckedRounded
                sx={{
                  color: live ? "error.main" : "primary.main",
                  fontSize: 20,
                }}
              />
            </Box>
            <Box>
              <Typography variant="subtitle2">
                {paperOnly ? "MAINNET PAPER-ONLY" : "Trading controls"}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {status?.busy
                  ? "Validating an opportunity"
                  : state === "STOPPED"
                  ? "Scanner is stopped"
                  : state === "PAUSED"
                  ? "Trading is paused"
                  : "Block-driven scanner"}{" "}
                · {status?.summary?.pending ?? "—"} pending receipts
              </Typography>
            </Box>
            <StatusBadge value={state} />
          </Box>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button
              variant={state === "PAPER" ? "outlined" : "contained"}
              startIcon={<PlayArrowRounded />}
              disabled={busy || stale}
              onClick={() => action("paper")}
            >
              PAPER
            </Button>
            <Button
              variant="outlined"
              startIcon={<ShieldOutlined />}
              disabled={busy || stale || paperOnly || state !== "PAPER"}
              onClick={() => action("arm")}
            >
              Arm live trading
            </Button>
            <Button
              color="error"
              variant="contained"
              disabled={busy || stale || paperOnly || !armed}
              onClick={() => action("live")}
            >
              GO LIVE
            </Button>
            <Button
              color="warning"
              variant="outlined"
              startIcon={<PauseRounded />}
              disabled={busy}
              onClick={() => action("pause")}
            >
              Emergency pause
            </Button>
          </Box>
        </Box>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 2,
            flexWrap: "wrap",
            mt: 2,
            pt: 1.5,
            borderTop: "1px solid",
            borderColor: "divider",
          }}
        >
          <Typography
            variant="body2"
            color={live ? "error.main" : "text.secondary"}
          >
            {live
              ? "LIVE MODE — REAL FUNDS. Transactions are signed and submitted privately."
              : state === "PAPER"
              ? "PAPER: scanning and on-chain simulation. No trade signing or submission."
              : armed
              ? `Armed for ${Math.max(
                  0,
                  Math.ceil((status.trading.armedUntil - Date.now()) / 1000)
                )}s. GO LIVE is a separate action.`
              : "Choose PAPER to scan and validate opportunities."}
          </Typography>
          <Button
            size="small"
            onClick={inspectReadiness}
            startIcon={<ShieldOutlined />}
          >
            Live readiness
          </Button>
        </Box>
        {paperOnly && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Live signing disabled by deployment configuration.
          </Alert>
        )}
        {(error || actionError) && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {actionError || error}
          </Alert>
        )}
        {stale && status && !error && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            Trading status is stale. Refresh before changing modes.
          </Alert>
        )}
        {status?.trading?.reason && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {status.trading.reason}
          </Alert>
        )}
        {status?.readiness && !status.readiness.ready && (
          <Typography
            variant="caption"
            color="warning.main"
            sx={{ display: "block", mt: 1.5 }}
          >
            Live trading remains unavailable. Review readiness for the
            outstanding checks.
          </Typography>
        )}
      </Panel>
      {!compact && (
        <Box sx={{ mt: 3 }}>
          <ExecutionHistory />
        </Box>
      )}
      <Dialog
        open={readinessOpen}
        onClose={() => setReadinessOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Live trading readiness</DialogTitle>
        <DialogContent>
          {checking ? (
            <Box sx={{ py: 4, textAlign: "center" }}>
              <CircularProgress size={28} />
              <Typography sx={{ mt: 2 }} variant="body2">
                Checking contract, signer and commissioning evidence…
              </Typography>
            </Box>
          ) : (
            <>
              <Alert
                severity={readiness?.ready ? "success" : "warning"}
                sx={{ mb: 2 }}
              >
                {readiness?.ready
                  ? "Readiness checks passed. Arming and GO LIVE remain separate actions."
                  : "Live trading remains unavailable."}
              </Alert>
              {readiness?.errors?.map((reason, i) => (
                <Box key={i} sx={{ display: "flex", gap: 1.5, mb: 1.5 }}>
                  <Chip label={i + 1} />
                  <Typography variant="body2">{reason}</Typography>
                </Box>
              ))}
              <Typography variant="caption" color="text.secondary">
                PAPER is unsigned and does not commission the relay. Contract
                verification, fork proof, burn-in and commissioning evidence
                must match.
              </Typography>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReadinessOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
