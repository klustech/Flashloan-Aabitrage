import React, { useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  InputAdornment,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  TextField,
  Typography,
  Alert,
  Divider,
} from "@mui/material";
import {
  CloseRounded,
  OpenInNewRounded,
  SearchRounded,
  ReceiptLongRounded,
} from "@mui/icons-material";
import { useTradingStatus } from "../hooks/useTradingStatus";
import {
  EmptyState,
  Panel,
  StatusBadge,
  RouteFlow,
  Address,
} from "../ui/Primitives";
import { formatUnits, routeLabel, time, positive } from "../ui/format";

export function ExecutionDetails({ record, onClose }) {
  const { status } = useTradingStatus();
  if (!record) return null;
  const unit = record.token?.symbol || "token",
    decimals = record.token?.decimals;
  const fields = [
    ["Borrow amount", "borrowAmount"],
    ["Expected return", "expectedFinalAmount"],
    ["Flash-loan premium", "flashloanFee"],
    ["Estimated gas cost", "estimatedGasCostBorrowToken"],
    ["Builder allowance", "estimatedBuilderPaymentBorrowToken"],
    ["Expected net profit", "expectedNetProfit"],
  ];
  const accuracy = status?.summary?.accuracy?.[record.borrowToken];
  return (
    <Box sx={{ p: { xs: 2.5, sm: 3.5 } }}>
      <Box className="panel-heading">
        <Box>
          <Typography variant="overline" color="text.secondary">
            Execution record
          </Typography>
          <Typography variant="h5">Trade details</Typography>
        </Box>
        <IconButton aria-label="Close trade details" onClick={onClose}>
          <CloseRounded />
        </IconButton>
      </Box>
      <Box sx={{ display: "flex", gap: 1, mb: 2 }}>
        <Chip label={record.mode || "Unknown mode"} variant="outlined" />
        <StatusBadge value={record.status} />
        <Chip label={unit} />
      </Box>
      <Typography variant="body2" color="text.secondary">
        {time(record.updatedAt || record.discoveredAt)} · Quote block{" "}
        {record.stateBlock ?? "—"}
      </Typography>
      {record.reason && (
        <Alert
          severity={record.status === "REVERTED" ? "error" : "info"}
          sx={{ mt: 2 }}
        >
          {record.reason}
        </Alert>
      )}
      <Divider sx={{ my: 3 }} />
      <Typography variant="subtitle2" sx={{ mb: 2 }}>
        Exact route
      </Typography>
      <RouteFlow legs={record.route?.legs} />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mt: 1.5 }}
      >
        {record.route?.strategy?.replaceAll("_", " ").toLowerCase()}
      </Typography>
      <Divider sx={{ my: 3 }} />
      <Typography variant="subtitle2" sx={{ mb: 2 }}>
        Profit & cost breakdown
      </Typography>
      <Box className="execution-detail-grid">
        {fields.map(([label, key]) => (
          <Box
            key={key}
            sx={{ p: 1.7, bgcolor: "background.default", borderRadius: 2 }}
          >
            <Typography variant="caption" color="text.secondary">
              {label}
            </Typography>
            <Typography
              sx={{
                fontWeight: 550,
                overflowWrap: "anywhere",
                color:
                  key === "expectedNetProfit" &&
                  positive(record.economics?.[key])
                    ? "success.main"
                    : "text.primary",
              }}
            >
              {formatUnits(record.economics?.[key], decimals)}{" "}
              <Box
                component="span"
                sx={{ color: "text.secondary", fontSize: ".75rem" }}
              >
                {unit}
              </Box>
            </Typography>
          </Box>
        ))}
      </Box>
      <Box
        sx={{
          p: 2,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 2,
          mt: 2,
        }}
      >
        <Typography variant="body2" color="text.secondary">
          Realized net profit
        </Typography>
        <Typography variant="h6">
          {formatUnits(record.realizedNetProfit, decimals)} {unit}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Actual gas: {formatUnits(record.actualGasCostNative, 18)} ETH
        </Typography>
      </Box>
      <Divider sx={{ my: 3 }} />
      <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
        Validation
      </Typography>
      <Box sx={{ display: "grid", gap: 1.5 }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
          }}
        >
          <Typography variant="body2" color="text.secondary">
            Contract simulation
          </Typography>
          <Chip
            label={record.simulation?.callStatic ? "Passed" : "Not recorded"}
            color={record.simulation?.callStatic ? "success" : "default"}
          />
        </Box>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 1,
          }}
        >
          <Typography variant="body2" color="text.secondary">
            Private bundle
          </Typography>
          <Chip
            label={
              record.simulation?.bundle
                ? "Passed"
                : record.mode === "PAPER"
                ? "Unsigned PAPER — not run"
                : "Not recorded"
            }
            color={record.simulation?.bundle ? "success" : "default"}
          />
        </Box>
      </Box>
      {accuracy && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Prediction error: mean {formatUnits(accuracy.mean, decimals)}, median{" "}
          {formatUnits(accuracy.median, decimals)}, p95{" "}
          {formatUnits(accuracy.p95, decimals)} {unit}
        </Typography>
      )}
      {record.borrowToken && (
        <Box sx={{ mt: 3 }}>
          <Typography variant="caption" color="text.secondary">
            Borrow token
          </Typography>
          <Box sx={{ overflowWrap: "anywhere" }}>
            <Address value={record.borrowToken} label={record.borrowToken} />
          </Box>
        </Box>
      )}
      {record.txHash && (
        <Button
          variant="outlined"
          fullWidth
          href={`https://etherscan.io/tx/${record.txHash}`}
          target="_blank"
          rel="noreferrer"
          endIcon={<OpenInNewRounded />}
          sx={{ mt: 3 }}
        >
          View transaction on Etherscan
        </Button>
      )}
      {record.mode === "PAPER" && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 3 }}
        >
          This is an unsigned simulation. Its expected profit is not realized
          income.
        </Typography>
      )}
    </Box>
  );
}
export default function ExecutionHistory({ compact = false }) {
  const { status, loading, error } = useTradingStatus();
  const [filter, setFilter] = useState("ALL"),
    [mode, setMode] = useState("ALL"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState(null);
  const rows = useMemo(
    () =>
      (status?.executions || []).filter(
        (r) =>
          (filter === "ALL" || r.status === filter) &&
          (mode === "ALL" || r.mode === mode) &&
          `${routeLabel(r)} ${r.token?.symbol || ""} ${r.reason || ""} ${r.id}`
            .toLowerCase()
            .includes(query.toLowerCase())
      ),
    [status, filter, mode, query]
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / 10) - 1)
  );
  const visible = compact
    ? rows.slice(0, 5)
    : rows.slice(currentPage * 10, currentPage * 10 + 10);
  const record = status?.executions?.find((r) => r.id === selected);
  const update = (setter) => (event) => {
    setter(event.target.value);
    setPage(0);
  };
  return (
    <Panel
      title={compact ? "Recent executions" : "Execution ledger"}
      subtitle="Expected and realized profit stay separate. Select a record for its complete breakdown."
      action={<Chip label={`${rows.length} records`} variant="outlined" />}
    >
      {!compact && (
        <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap", mb: 2.5 }}>
          <TextField
            size="small"
            label="Search executions"
            value={query}
            onChange={update(setQuery)}
            sx={{ flex: 1, minWidth: 180 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
            }}
          />
          <TextField
            select
            size="small"
            label="Status"
            value={filter}
            onChange={update(setFilter)}
            sx={{ minWidth: 140 }}
          >
            {[
              "ALL",
              "SIMULATED",
              "SUBMITTED",
              "INCLUDED",
              "REVERTED",
              "DROPPED",
              "DISCOVERED",
            ].map((v) => (
              <MenuItem key={v} value={v}>
                {v === "ALL" ? "All statuses" : v}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Mode"
            value={mode}
            onChange={update(setMode)}
            sx={{ minWidth: 120 }}
          >
            {["ALL", "PAPER", "LIVE"].map((v) => (
              <MenuItem key={v} value={v}>
                {v === "ALL" ? "All modes" : v}
              </MenuItem>
            ))}
          </TextField>
        </Box>
      )}
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Records could not be refreshed. Last received data is shown.
        </Alert>
      )}
      {visible.length ? (
        <TableContainer
          sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2 }}
        >
          <Table size="small" aria-label="Execution ledger">
            <TableHead>
              <TableRow>
                <TableCell>Time / mode</TableCell>
                <TableCell>Route</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Expected net</TableCell>
                <TableCell align="right">Realized net</TableCell>
                <TableCell>Details</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>
                    <Typography variant="body2">
                      {time(r.updatedAt || r.discoveredAt)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {r.mode}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ minWidth: 180, maxWidth: 330 }}>
                    <Typography variant="body2" sx={{ fontWeight: 550 }}>
                      {routeLabel(r)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {r.token?.symbol || "Unknown token"} ·{" "}
                      {r.route?.legs?.length || "—"} swaps
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={r.status} />
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      whiteSpace: "nowrap",
                      color: positive(r.economics?.expectedNetProfit)
                        ? "success.main"
                        : "text.secondary",
                    }}
                  >
                    {formatUnits(
                      r.economics?.expectedNetProfit,
                      r.token?.decimals
                    )}{" "}
                    <Typography component="span" variant="caption">
                      {r.token?.symbol}
                    </Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                    {formatUnits(r.realizedNetProfit, r.token?.decimals)}{" "}
                    <Typography component="span" variant="caption">
                      {r.token?.symbol}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      onClick={() => setSelected(r.id)}
                      aria-label={`View execution ${r.id}`}
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <EmptyState
          icon={ReceiptLongRounded}
          compact={compact}
          title={
            loading
              ? "Loading executions"
              : query || filter !== "ALL" || mode !== "ALL"
              ? "No matching executions"
              : "No execution records yet"
          }
          description={
            loading
              ? "Connecting to the production ledger."
              : "Start PAPER scanning to inspect opportunities, rejection reasons and contract simulations."
          }
        />
      )}
      {!compact && rows.length > 0 && (
        <TablePagination
          component="div"
          count={rows.length}
          page={currentPage}
          onPageChange={(_, p) => setPage(p)}
          rowsPerPage={10}
          rowsPerPageOptions={[10]}
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
