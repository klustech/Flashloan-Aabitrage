import React from "react";
import { Box, Typography, Chip, LinearProgress } from "@mui/material";
import { ArrowForwardRounded } from "@mui/icons-material";
import { useTradingStatus } from "../hooks/useTradingStatus";
import { Panel, EmptyState } from "../ui/Primitives";
import { number } from "../ui/format";
export default function ScannerPanel() {
  const { status } = useTradingStatus(),
    latency = status?.latency,
    cache = latency?.cache,
    scanner = status?.scanner,
    backrun = status?.profile?.backrun;
  const stages = [
    ["Cached pools", cache?.pools, latency?.stageTimes?.cacheMs],
    ["Exact screens", latency?.screened, latency?.stageTimes?.screeningMs],
    ["Sized routes", latency?.sized, latency?.stageTimes?.sizingMs],
    [
      "Contract calls",
      latency?.transactionCalls,
      latency?.stageTimes?.preparationMs,
    ],
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
      subtitle="From pool state to a guarded transaction simulation."
      action={
        <Chip
          variant="outlined"
          label={scanner?.source || "Waiting for scanner"}
        />
      }
    >
      {!latency ? (
        <EmptyState
          compact
          title="Waiting for the first scan"
          description="Start PAPER to see cache updates, exact quotes and validation timings."
        />
      ) : (
        <>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.2,
              flexWrap: "wrap",
            }}
          >
            {stages.map(([label, count, ms], i) => (
              <React.Fragment key={label}>
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 120,
                    p: 1.7,
                    bgcolor: "background.default",
                    borderRadius: 2,
                  }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {label}
                  </Typography>
                  <Typography variant="h5" sx={{ my: 0.6 }}>
                    {number(count)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {number(ms)} ms
                  </Typography>
                </Box>
                {i < 3 && (
                  <ArrowForwardRounded
                    sx={{
                      fontSize: 16,
                      color: "text.secondary",
                      display: { xs: "none", md: "block" },
                    }}
                  />
                )}
              </React.Fragment>
            ))}
          </Box>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 1,
              mt: 2.5,
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Block{" "}
              <Box
                component="span"
                className="mono"
                sx={{ color: "text.primary" }}
              >
                {number(cache?.block)}
              </Box>{" "}
              · Last scan: {number(latency.durationMs)} ms
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {reasons[latency.screeningStopReason] || "Scan completed"}
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={
              latency.candidates?.profitableMarginal
                ? Math.min(
                    100,
                    ((latency.screeningAttempted || latency.screened || 0) /
                      latency.candidates.profitableMarginal) *
                      100
                  )
                : 0
            }
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
                <Box component="span" sx={{ color: "text.primary" }}>
                  {number(value)}
                </Box>
              </Typography>
            ))}
          </Box>
          {backrun && (
            <Box
              sx={{
                mt: 2,
                p: 1.5,
                borderRadius: 2,
                bgcolor: "background.default",
                display: "flex",
                gap: 1,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <Chip
                size="small"
                variant={backrun.enabled ? "filled" : "outlined"}
                label={backrun.enabled ? "Backrun PAPER enabled" : "Backrun disabled"}
              />
              <Typography variant="caption" color="text.secondary">
                Order flow: {backrun.orderflowSource || "disabled"} · Funding:{" "}
                {backrun.fundingMode || "adaptive"} · Priority:{" "}
                {(backrun.borrowSymbols || []).join(" → ") || "WETH"}
              </Typography>
            </Box>
          )}
          {cache?.lastLogError && (
            <Typography variant="body2" color="warning.main" sx={{ mt: 2 }}>
              Pool refresh fallback: {cache.lastLogError}
            </Typography>
          )}
          {["candidate_cap", "screening_budget"].includes(
            latency.screeningStopReason
          ) && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mt: 1.5 }}
            >
              Remaining routes rotate into later scans. Screening limits do not
              bypass transaction checks.
            </Typography>
          )}
        </>
      )}
    </Panel>
  );
}
