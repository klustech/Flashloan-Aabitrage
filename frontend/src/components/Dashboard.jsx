import React, { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  AccountBalanceWalletOutlined,
  ArrowOutwardRounded,
  BoltRounded,
  DashboardOutlined,
  HubOutlined,
  InsightsOutlined,
  ReceiptLongOutlined,
  RefreshRounded,
  ScienceOutlined,
  SettingsOutlined,
  SpeedRounded,
  StackedLineChartOutlined,
} from "@mui/icons-material";
import {
  TradingStatusProvider,
  useTradingStatus,
} from "../hooks/useTradingStatus";
import { Metric, Panel, StatusBadge } from "../ui/Primitives";
import { formatUnits, number, time } from "../ui/format";
import TradingControl from "./TradingControl";
import ExecutionHistory from "./ExecutionHistory";
import ScannerPanel from "./ScannerPanel";
import ProfitChart from "./ProfitChart";
import BotStatus from "./BotStatus";
import RouteVisualization from "./RouteVisualization";
import RealTimeOpportunities from "./RealTimeOpportunities";
import MLStatistics from "./MLStatistics";
import ProfitSimulator from "./ProfitSimulator";
const PAGES = [
  {
    id: "overview",
    label: "Overview",
    icon: DashboardOutlined,
    title: "Market overview",
    description:
      "Your scanner, performance and latest executions in one workspace.",
  },
  {
    id: "executions",
    label: "Executions",
    icon: ReceiptLongOutlined,
    title: "Execution ledger",
    description: "Inspect simulations, rejected candidates and settled trades.",
  },
  {
    id: "routes",
    label: "Route explorer",
    icon: HubOutlined,
    title: "Route explorer",
    description:
      "Explore exact pools, swap directions and candidate economics.",
  },
  {
    id: "opportunities",
    label: "Opportunities",
    icon: BoltRounded,
    title: "Opportunity monitor",
    description:
      "Follow production simulations as they reach the execution ledger.",
  },
  {
    id: "simulator",
    label: "Simulator",
    icon: ScienceOutlined,
    title: "Strategy simulator",
    description:
      "Explore illustrative route economics before reviewing production quotes.",
  },
  {
    id: "analytics",
    label: "ML analytics",
    icon: InsightsOutlined,
    title: "Model analytics",
    description:
      "Optional model diagnostics. Production execution remains deterministic.",
  },
  {
    id: "system",
    label: "System & settings",
    icon: SettingsOutlined,
    title: "System & settings",
    description:
      "Inspect health, scanner diagnostics and your operator settings.",
  },
];
function Workspace({ adminMode }) {
  const { status, error, loading, refreshing, stale, updatedAt, refresh } =
    useTradingStatus();
  const [active, setActive] = useState("overview"),
    [token, setToken] = useState("");
  const page = PAGES.find((p) => p.id === active),
    groups = Object.values(status?.summary?.tokens || {});
  const selected =
    groups.find((g) => g.borrowToken === token) ||
    groups.find((g) => g.token?.symbol === "DAI") ||
    groups[0];
  const currency = selected?.token?.symbol || "DAI",
    unit = selected?.token?.decimals;
  const simulations = status?.executions?.filter(
    (r) => r.mode === "PAPER" && r.status === "SIMULATED"
  ).length;
  const nav = (mobile = false) => (
    <Box
      component="nav"
      aria-label={
        mobile ? "Mobile workspace navigation" : "Workspace navigation"
      }
      className={mobile ? "mobile-navigation dashboard-nav" : "dashboard-nav"}
      sx={mobile ? { m: 0 } : undefined}
    >
      {PAGES.map(({ id, label, icon: Icon }) => (
        <button
          type="button"
          key={id}
          aria-current={active === id ? "page" : undefined}
          onClick={() => setActive(id)}
        >
          <Icon sx={{ fontSize: 20 }} />
          {label}
        </button>
      ))}
    </Box>
  );
  return (
    <Box className="dashboard-shell">
      <a className="skip-link" href="#workspace-content">
        Skip to content
      </a>
      <Box component="aside" className="dashboard-sidebar">
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 1 }}>
          <Box
            sx={{
              display: "grid",
              placeItems: "center",
              width: 37,
              height: 37,
              bgcolor: "primary.main",
              color: "primary.contrastText",
              borderRadius: 2.5,
            }}
          >
            <StackedLineChartOutlined />
          </Box>
          <Box>
            <Typography
              sx={{
                fontSize: "1.05rem",
                fontWeight: 650,
                letterSpacing: "-.04em",
              }}
            >
              Kluster Arbitrage
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Operator workspace
            </Typography>
          </Box>
        </Box>
        {nav()}
        <Box
          sx={{
            mt: "auto",
            p: 1.5,
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 2,
          }}
        >
          <Typography variant="caption" color="text.secondary">
            PRODUCTION PROFILE
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            Ethereum · Aave V2
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 0.5 }}
          >
            Private execution · 2–3 swaps
          </Typography>
          <Box sx={{ mt: 1.5 }}>
            <StatusBadge value={status?.trading?.state} />
          </Box>
        </Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ pt: 2, px: 1 }}
        >
          Klustertech / Ethereum
        </Typography>
      </Box>
      <Box className="dashboard-body">
        <Box component="header" className="dashboard-topbar">
          <Typography variant="body2" color="text.secondary">
            Workspace{" "}
            <Box component="span" sx={{ px: 1.5, opacity: 0.5 }}>
              /
            </Box>
            <Box component="span" sx={{ color: "text.primary" }}>
              {page.label}
            </Box>
          </Typography>
          <Box
            sx={{
              display: "flex",
              gap: 1.5,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {adminMode && (
              <Chip label="Admin" color="secondary" variant="outlined" />
            )}
            <Chip label="Ethereum" variant="outlined" />
            <Typography
              variant="caption"
              color={stale ? "warning.main" : "text.secondary"}
            >
              {loading
                ? "Connecting…"
                : stale
                ? "Connection needs attention"
                : `Updated ${time(updatedAt)}`}
            </Typography>
            <Tooltip title="Refresh trading status">
              <span>
                <IconButton
                  aria-label="Refresh trading status"
                  onClick={refresh}
                  disabled={refreshing}
                >
                  <RefreshRounded sx={{ fontSize: 20 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </Box>
        {nav(true)}
        <Box
          component="main"
          id="workspace-content"
          className="dashboard-main"
          tabIndex={-1}
        >
          <Box
            sx={{
              mb: 3,
              display: "flex",
              justifyContent: "space-between",
              gap: 2,
              flexWrap: "wrap",
            }}
          >
            <Box>
              <Typography
                variant="overline"
                color="primary"
                sx={{ letterSpacing: ".16em", fontSize: ".65rem" }}
              >
                ARBITRAGE OPERATIONS
              </Typography>
              <Typography component="h1" variant="h4" sx={{ mt: 0.5 }}>
                {page.title}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {page.description}
              </Typography>
            </Box>
            {active === "overview" && groups.length > 1 && (
              <TextField
                select
                size="small"
                label="Account token"
                value={selected?.borrowToken || ""}
                onChange={(e) => setToken(e.target.value)}
                sx={{ minWidth: 140, alignSelf: "center" }}
              >
                {groups.map((g) => (
                  <MenuItem key={g.borrowToken} value={g.borrowToken}>
                    {g.token?.symbol || g.borrowToken}
                  </MenuItem>
                ))}
              </TextField>
            )}
          </Box>
          <TradingControl compact />
          {error && (
            <Alert severity="warning" sx={{ mb: 3 }}>
              The API could not be refreshed. Last received values may be stale;
              trading changes require a fresh status.
            </Alert>
          )}
          {active === "overview" && (
            <Box sx={{ display: "grid", gap: 3 }}>
              <Box className="dashboard-grid">
                <Metric
                  label="Realized net profit"
                  value={formatUnits(selected?.realizedNet, unit)}
                  unit={currency}
                  hint="Settled LIVE trades only"
                  icon={AccountBalanceWalletOutlined}
                  color="success.main"
                />
                <Metric
                  label="PAPER simulations"
                  value={number(simulations)}
                  hint="In the latest 100 execution records"
                  icon={ReceiptLongOutlined}
                />
                <Metric
                  label="Last scan latency"
                  value={number(status?.latency?.durationMs)}
                  unit="ms"
                  hint="Measured production cycle"
                  icon={SpeedRounded}
                />
                <Metric
                  label="Cached pools"
                  value={number(status?.latency?.cache?.pools)}
                  hint={`${number(
                    status?.latency?.cache?.reusedPools
                  )} reused in last scan`}
                  icon={HubOutlined}
                />
              </Box>
              <Box className="dashboard-split">
                <ProfitChart borrowToken={selected?.borrowToken} />
                <Panel
                  title="Operating profile"
                  subtitle="A deterministic path from quote to private execution."
                >
                  <Box sx={{ display: "grid", gap: 2.2 }}>
                    {[
                      ["Network", "Ethereum"],
                      ["Flash-loan provider", "Aave V2"],
                      ["Strategies", "Two-pool & three-leg cycles"],
                      ["Submission", "Approved private relays"],
                      ["Head", number(status?.latency?.cache?.block)],
                    ].map(([label, value]) => (
                      <Box
                        key={label}
                        sx={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 1,
                        }}
                      >
                        <Typography variant="body2" color="text.secondary">
                          {label}
                        </Typography>
                        <Typography
                          variant="body2"
                          sx={{ fontWeight: 500, textAlign: "right" }}
                        >
                          {value}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                  <Box
                    sx={{
                      mt: 3,
                      p: 2,
                      bgcolor: "background.default",
                      borderRadius: 2,
                    }}
                  >
                    <Typography variant="subtitle2">
                      {status?.readiness?.ready
                        ? "Readiness checks passed"
                        : "Commissioning remains gated"}
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mt: 1 }}
                    >
                      LIVE requires matching contract verification, fork proof,
                      continuous PAPER evidence and relay simulation.
                    </Typography>
                  </Box>
                  <Button
                    endIcon={<ArrowOutwardRounded />}
                    sx={{ mt: 2, px: 0 }}
                    onClick={() => setActive("system")}
                  >
                    Inspect system & settings
                  </Button>
                </Panel>
              </Box>
              <ScannerPanel />
              <ExecutionHistory compact />
            </Box>
          )}
          {active === "executions" && <ExecutionHistory />}
          {active === "routes" && <RouteVisualization />}
          {active === "opportunities" && <RealTimeOpportunities />}
          {active === "simulator" && <ProfitSimulator />}
          {active === "analytics" && <MLStatistics />}
          {active === "system" && (
            <Box sx={{ display: "grid", gap: 3 }}>
              <ScannerPanel />
              <BotStatus />
            </Box>
          )}
          <Box
            component="footer"
            sx={{
              display: "flex",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 1,
              pt: 4,
            }}
          >
            <Typography variant="caption" color="text.secondary">
              Kluster Arbitrage · Private operator dashboard
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Expected profit ≠ realized profit
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
export default function Dashboard(props) {
  return (
    <TradingStatusProvider>
      <Workspace {...props} />
    </TradingStatusProvider>
  );
}
