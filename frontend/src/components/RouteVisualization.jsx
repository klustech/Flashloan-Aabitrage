import React, { useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Drawer,
  InputAdornment,
  TextField,
  Typography,
} from "@mui/material";
import { SearchRounded, HubOutlined } from "@mui/icons-material";
import { getOpportunities } from "../services/api";
import { useTradingStatus } from "../hooks/useTradingStatus";
import {
  EmptyState,
  Panel,
  RouteFlow,
  StatusBadge,
  Address,
} from "../ui/Primitives";
import { DEX_LABELS, formatUnits, positive, routeLabel } from "../ui/format";
import { ExecutionDetails } from "./ExecutionHistory";
import OpportunitiesTable from "./OpportunitiesTable";
export default function RouteVisualization() {
  const { status } = useTradingStatus();
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(null),
    [legacy, setLegacy] = useState(null),
    [legacyError, setLegacyError] = useState(""),
    [loadingLegacy, setLoadingLegacy] = useState(false);
  const routes = useMemo(() => {
    const map = new Map();
    for (const row of status?.executions || [])
      if (row.route?.legs?.length && !map.has(row.candidateId || row.id))
        map.set(row.candidateId || row.id, row);
    return [...map.values()].filter((r) =>
      `${routeLabel(r)} ${r.token?.symbol || ""} ${r.route.legs
        .map((l) => l.poolAddress)
        .join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  }, [status, query]);
  const fetchLegacy = async () => {
    setLoadingLegacy(true);
    setLegacyError("");
    try {
      const response = await getOpportunities();
      setLegacy(response.opportunities || []);
    } catch (e) {
      setLegacyError(e.response?.data?.error || e.message);
    } finally {
      setLoadingLegacy(false);
    }
  };
  const record = status?.executions?.find((r) => r.id === selected);
  return (
    <Box sx={{ display: "grid", gap: 3 }}>
      <Panel
        title="Production routes"
        subtitle="Latest record for each route in the available execution window."
        action={<Chip label={`${routes.length} routes`} variant="outlined" />}
      >
        <TextField
          fullWidth
          size="small"
          label="Search venue, token or pool address"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ mb: 3 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchRounded sx={{ fontSize: 18 }} />
              </InputAdornment>
            ),
          }}
        />
        {routes.length ? (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", xl: "repeat(2,minmax(0,1fr))" },
              gap: 2,
            }}
          >
            {routes.map((r) => (
              <Box
                key={r.id}
                sx={{
                  p: 2.5,
                  bgcolor: "background.default",
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: 2.5,
                }}
              >
                <Box className="panel-heading">
                  <Box>
                    <Typography variant="subtitle2">
                      {r.token?.symbol || "Token"} cycle · {r.route.legs.length}{" "}
                      swaps
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Block {r.stateBlock ?? "—"} · {r.mode}
                    </Typography>
                  </Box>
                  <StatusBadge value={r.status} />
                </Box>
                <RouteFlow legs={r.route.legs} />
                <Box sx={{ display: "grid", gap: 0.8, my: 2 }}>
                  {r.route.legs.map((leg, i) => (
                    <Box
                      key={i}
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 1,
                        flexWrap: "wrap",
                      }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        Swap {i + 1} · {DEX_LABELS[leg.dex] || leg.dex}
                      </Typography>
                      <Box
                        sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
                      >
                        <Address value={leg.tokenIn} />
                        <Typography variant="caption" color="text.secondary">
                          →
                        </Typography>
                        <Address value={leg.tokenOut} />
                      </Box>
                    </Box>
                  ))}
                </Box>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "end",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 1,
                  }}
                >
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Expected net
                    </Typography>
                    <Typography
                      variant="h6"
                      sx={{
                        color: positive(r.economics?.expectedNetProfit)
                          ? "success.main"
                          : "text.secondary",
                      }}
                    >
                      {formatUnits(
                        r.economics?.expectedNetProfit,
                        r.token?.decimals
                      )}{" "}
                      {r.token?.symbol}
                    </Typography>
                  </Box>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => setSelected(r.id)}
                  >
                    Inspect route
                  </Button>
                </Box>
                {r.reason && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", mt: 2 }}
                  >
                    {r.reason}
                  </Typography>
                )}
              </Box>
            ))}
          </Box>
        ) : (
          <EmptyState
            icon={HubOutlined}
            title={
              query ? "No matching routes" : "Routes appear after scanning"
            }
            description="Production candidates retain the exact venue, pool and swap direction. Start PAPER to populate the route explorer."
          />
        )}
      </Panel>
      <Panel
        title="Legacy route diagnostics"
        subtitle="Optional discovery output from the existing opportunity API. This is separate from the production ledger."
        action={
          <Button
            variant="outlined"
            size="small"
            onClick={fetchLegacy}
            disabled={loadingLegacy}
          >
            {loadingLegacy
              ? "Loading…"
              : legacy === null
              ? "Load diagnostics"
              : "Refresh diagnostics"}
          </Button>
        }
      >
        {legacyError && <Alert severity="error">{legacyError}</Alert>}
        {legacy !== null && <OpportunitiesTable opportunities={legacy} />}
      </Panel>
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
    </Box>
  );
}
