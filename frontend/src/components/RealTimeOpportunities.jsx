import React, { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Chip, Drawer, Typography } from "@mui/material";
import {
  BoltRounded,
  PauseRounded,
  PlayArrowRounded,
  RefreshRounded,
} from "@mui/icons-material";
import { useTradingStatus } from "../hooks/useTradingStatus";
import { EmptyState, Panel, RouteFlow, StatusBadge } from "../ui/Primitives";
import { formatUnits, time, positive } from "../ui/format";
import { ExecutionDetails } from "./ExecutionHistory";
export default function RealTimeOpportunities({ wsEndpoint }) {
  const { status, refresh, stale } = useTradingStatus();
  const [connected, setConnected] = useState(false),
    [paused, setPaused] = useState(false),
    [frozen, setFrozen] = useState([]),
    [selected, setSelected] = useState(null);
  const lastRefresh = useRef(0),
    pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    let mounted = true,
      socket,
      retry;
    const connect = () => {
      if (!mounted) return;
      try {
        socket = new WebSocket(
          wsEndpoint ||
            `${window.location.protocol === "https:" ? "wss" : "ws"}://${
              window.location.host
            }/ws`
        );
        socket.onopen = () => mounted && setConnected(true);
        socket.onmessage = (event) => {
          if (!mounted || pausedRef.current) return;
          try {
            const message = JSON.parse(event.data);
            if (
              ["opportunity", "trade_executed", "scan_completed"].includes(
                message.type
              ) &&
              Date.now() - lastRefresh.current > 1000
            ) {
              lastRefresh.current = Date.now();
              refresh();
            }
          } catch (_) {
            /* Ignore malformed or unrelated transport messages. */
          }
        };
        socket.onclose = () => {
          if (!mounted) return;
          setConnected(false);
          retry = setTimeout(connect, 5000);
        };
        socket.onerror = () => {
          if (mounted) setConnected(false);
          socket.close();
        };
      } catch (_) {
        if (mounted) {
          setConnected(false);
          retry = setTimeout(connect, 5000);
        }
      }
    };
    connect();
    return () => {
      mounted = false;
      clearTimeout(retry);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [wsEndpoint, refresh]);
  const current = (status?.executions || []).filter((r) =>
    ["SIMULATED", "SUBMITTED", "INCLUDED"].includes(r.status)
  );
  const rows = (paused ? frozen : current).slice(0, 20),
    record = rows.find((r) => r.id === selected);
  const toggle = () => {
    if (!paused) setFrozen(current);
    setPaused(!paused);
  };
  return (
    <Panel
      title="Production opportunities"
      subtitle="Full transaction simulations and tracked private submissions, sourced from the production ledger."
      action={
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Chip
            label={
              paused
                ? "Feed paused"
                : connected
                ? "WebSocket updates"
                : "Polling every 15s"
            }
            variant="outlined"
            color={connected && !paused ? "success" : "default"}
          />
          <Button
            size="small"
            variant="outlined"
            startIcon={paused ? <PlayArrowRounded /> : <PauseRounded />}
            onClick={toggle}
          >
            {paused ? "Resume feed" : "Pause feed"}
          </Button>
          <Button
            aria-label="Refresh opportunities"
            size="small"
            onClick={refresh}
            startIcon={<RefreshRounded />}
          >
            Refresh
          </Button>
        </Box>
      }
    >
      {paused && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Only this view is paused. The scanner and trading state are unchanged.
        </Alert>
      )}
      {stale && status && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Connection needs attention. Displayed records may be stale.
        </Alert>
      )}
      {rows.length ? (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", lg: "repeat(2,minmax(0,1fr))" },
            gap: 2,
          }}
        >
          {rows.map((row) => (
            <Box
              key={row.id}
              sx={{
                p: 2.5,
                borderRadius: 2.5,
                border: "1px solid",
                borderColor: "divider",
                bgcolor: "background.default",
              }}
            >
              <Box className="panel-heading">
                <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                  <BoltRounded sx={{ color: "primary.main", fontSize: 20 }} />
                  <Typography variant="subtitle2">
                    {row.token?.symbol || "Token"} opportunity
                  </Typography>
                </Box>
                <StatusBadge value={row.status} />
              </Box>
              <RouteFlow legs={row.route?.legs} />
              <Box
                sx={{
                  display: "flex",
                  gap: 1,
                  alignItems: "end",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  mt: 3,
                }}
              >
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Expected net · {row.mode}
                  </Typography>
                  <Typography
                    variant="h5"
                    color={
                      positive(row.economics?.expectedNetProfit)
                        ? "success.main"
                        : "text.primary"
                    }
                  >
                    {formatUnits(
                      row.economics?.expectedNetProfit,
                      row.token?.decimals
                    )}{" "}
                    <Box
                      component="span"
                      sx={{ fontSize: ".8rem", color: "text.secondary" }}
                    >
                      {row.token?.symbol}
                    </Box>
                  </Typography>
                </Box>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => setSelected(row.id)}
                >
                  View details
                </Button>
              </Box>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mt: 2 }}
              >
                {time(row.updatedAt)} · Block {row.stateBlock ?? "—"} ·{" "}
                {row.mode === "PAPER"
                  ? "Unsigned simulation"
                  : "Tracked execution"}
              </Typography>
            </Box>
          ))}
        </Box>
      ) : (
        <EmptyState
          title="Listening for validated opportunities"
          description="Profitable PAPER simulations and tracked LIVE submissions appear here. A quiet market can produce no executable opportunities."
        />
      )}
      <Drawer
        anchor="right"
        open={Boolean(record)}
        onClose={() => setSelected(null)}
        PaperProps={{
          sx: { width: { xs: "100%", sm: 580 }, maxWidth: "100%" },
        }}
      >
        <ExecutionDetails record={record} onClose={() => setSelected(null)} />
      </Drawer>
    </Panel>
  );
}
