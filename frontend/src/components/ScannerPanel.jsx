import React from "react";
import { Box, Typography, Chip, LinearProgress } from "@mui/material";
import { ArrowForwardRounded } from "@mui/icons-material";
import { useTradingStatus } from "../hooks/useTradingStatus";
import { Panel, EmptyState } from "../ui/Primitives";
import { number } from "../ui/format";

function StageRow({ stages }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.2, flexWrap: "wrap" }}>
      {stages.map(([label, count, detail], i) => (
        <React.Fragment key={label}>
          <Box sx={{ flex: 1, minWidth: 120, p: 1.7, bgcolor: "background.default", borderRadius: 2 }}>
            <Typography variant="caption" color="text.secondary">{label}</Typography>
            <Typography variant="h5" sx={{ my: 0.6 }}>{number(count)}</Typography>
            <Typography variant="caption" color="text.secondary">{detail || "—"}</Typography>
          </Box>
          {i < stages.length - 1 && (
            <ArrowForwardRounded sx={{ fontSize: 16, color: "text.secondary", display: { xs: "none", md: "block" } }} />
          )}
        </React.Fragment>
      ))}
    </Box>
  );
}

export default function ScannerPanel() {
  const { status } = useTradingStatus();
  const latency = status?.latency;
  const cache = latency?.cache;
  const scanner = status?.scanner;
  const opportunityMode = status?.profile?.opportunityMode || "block";
  const backrun = status?.backrun;
  const backrunStats = backrun?.engine?.stats;
  const backrunActive = opportunityMode === "backrun" || opportunityMode === "hybrid";

  if (backrunActive) {
    const sources = backrun?.sources || [];
    const connected = sources.filter((source) => source.connected).length;
    const sourceLabel = sources.length
      ? `${connected}/${sources.length} order-flow sources`
      : "Waiting for order flow";
    const stages = [
      ["Triggers", backrunStats?.triggers, "pending / hinted transactions"],
      ["State reproduced", backrunStats?.statePredicted, "post-trigger state"],
      ["Exact screens", backrunStats?.exactScreens, "affected routes only"],
      [
        "PAPER / LIVE",
        (backrunStats?.paperSimulated || 0) + (backrunStats?.liveSubmitted || 0),
        backrunStats?.liveSubmitted ? "private bundle submissions" : "guarded simulations",
      ],
    ];
    return (
      <Panel
        title="Transaction-triggered pipeline"
        subtitle="Order flow → exact post-trigger state → WETH-first route pricing → adaptive funding → guarded backrun."
        action={<Chip variant="outlined" label={sourceLabel} />}
      >
        {!backrun?.started ? (
          <EmptyState
            compact
            title="Backrun service is waiting"
            description="Start PAPER after the backrun RPC/order-flow preflight passes. PAPER never signs or submits a bundle."
          />
        ) : (
          <>
            <StageRow stages={stages} />
            <Box sx={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 1, mt: 2.5 }}>
              <Typography variant="body2" color="text.secondary">
                Last trigger{" "}
                <Box component="span" className="mono" sx={{ color: "text.primary" }}>
                  {backrunStats?.lastTrigger ? `${backrunStats.lastTrigger.slice(0, 10)}…` : "—"}
                </Box>
                {" "}· {number(backrunStats?.lastLatencyMs)} ms
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {backrunStats?.lastReason || "Waiting for a reproducible trigger"}
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={backrunStats?.triggers ? Math.min(100, ((backrunStats.statePredicted || 0) / backrunStats.triggers) * 100) : 0}
              sx={{ my: 1.5 }}
            />
            <Box sx={{ display: "flex", gap: 2.5, flexWrap: "wrap" }}>
              {[
                ["Affected pools", backrunStats?.affected],
                ["Post-trigger candidates", backrunStats?.candidates],
                ["Exact profitable", backrunStats?.exactProfitable],
                ["Sized", backrunStats?.sized],
                ["Rejected / expired", backrunStats?.rejected],
                ["Queue superseded", backrun?.scheduler?.superseded],
              ].map(([label, value]) => (
                <Typography key={label} variant="caption" color="text.secondary">
                  {label}:{" "}
                  <Box component="span" sx={{ color: "text.primary" }}>{number(value)}</Box>
                </Typography>
              ))}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
              Private hints that cannot be reproduced as exact post-trigger state are observation-only and never promoted to executable PAPER evidence.
            </Typography>
            {opportunityMode === "hybrid" && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
                Hybrid mode also keeps the completed-block scanner active as a separate residual-arbitrage signal.
              </Typography>
            )}
          </>
        )}
      </Panel>
    );
  }

  const stages = [
    ["Cached pools", cache?.pools, `${number(latency?.stageTimes?.cacheMs)} ms`],
    ["Exact screens", latency?.screened, `${number(latency?.stageTimes?.screeningMs)} ms`],
    ["Sized routes", latency?.sized, `${number(latency?.stageTimes?.sizingMs)} ms`],
    ["Contract calls", latency?.transactionCalls, `${number(latency?.stageTimes?.preparationMs)} ms`],
  ];
  const reasons = {
    enough_profitable: "Profitable shortlist ready",
    exhausted: "Candidates checked",
    candidate_cap: "Candidate limit reached",
    screening_budget: "Screening time limit reached",
  };

  return (
    <Panel
      title="Scanner pipeline"
      subtitle="From completed pool state to a guarded transaction simulation."
      action={<Chip variant="outlined" label={scanner?.source || "Waiting for scanner"} />}
    >
      {!latency ? (
        <EmptyState
          compact
          title="Waiting for the first scan"
          description="Start PAPER to see cache updates, exact quotes and validation timings."
        />
      ) : (
        <>
          <StageRow stages={stages} />
          <Box sx={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 1, mt: 2.5 }}>
            <Typography variant="body2" color="text.secondary">
              Block{" "}
              <Box component="span" className="mono" sx={{ color: "text.primary" }}>{number(cache?.block)}</Box>
              {" "}· Last scan: {number(latency.durationMs)} ms
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {reasons[latency.screeningStopReason] || "Scan completed"}
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={latency.candidates?.profitableMarginal
              ? Math.min(100, ((latency.screeningAttempted || latency.screened || 0) / latency.candidates.profitableMarginal) * 100)
              : 0}
            sx={{ my: 1.5 }}
          />
          <Box sx={{ display: "flex", gap: 2.5, flexWrap: "wrap" }}>
            {[
              ["Marginal candidates", latency.candidates?.profitableMarginal],
              ["Screening batches", latency.screeningBatches],
              ["Exact profitable", latency.screeningPassed],
              ["Gas estimates", latency.gasEstimates],
              ["Pool log fallbacks", cache?.logFallbacks],
            ].map(([label, value]) => (
              <Typography key={label} variant="caption" color="text.secondary">
                {label}:{" "}
                <Box component="span" sx={{ color: "text.primary" }}>{number(value)}</Box>
              </Typography>
            ))}
          </Box>
          {cache?.lastLogError && (
            <Typography variant="body2" color="warning.main" sx={{ mt: 2 }}>
              Pool refresh fallback: {cache.lastLogError}
            </Typography>
          )}
          {["candidate_cap", "screening_budget"].includes(latency.screeningStopReason) && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
              Remaining routes rotate into later scans. Screening limits do not bypass transaction checks.
            </Typography>
          )}
        </>
      )}
    </Panel>
  );
}
