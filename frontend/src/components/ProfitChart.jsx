/* global BigInt */
import React, { useId, useMemo, useState } from "react";
import {
  Box,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  Chip,
} from "@mui/material";
import { ShowChartRounded } from "@mui/icons-material";
import { useTradingStatus } from "../hooks/useTradingStatus";
import { Panel, EmptyState } from "../ui/Primitives";
import { formatUnits, time } from "../ui/format";
export default function ProfitChart({ borrowToken }) {
  const { status } = useTradingStatus(),
    [range, setRange] = useState("7d"),
    id = useId().replaceAll(":", "");
  const group = status?.summary?.tokens?.[borrowToken],
    decimals = group?.token?.decimals,
    symbol = group?.token?.symbol || "token";
  const data = useMemo(() => {
    const days = { "24h": 1, "7d": 7, "30d": 30, all: Infinity }[range];
    const rows = (status?.executions || [])
      .filter(
        (r) =>
          r.borrowToken === borrowToken &&
          r.mode === "LIVE" &&
          ["INCLUDED", "REVERTED"].includes(r.status) &&
          /^-?\d+$/.test(String(r.realizedNetProfit ?? "")) &&
          (r.updatedAt || 0) >= Date.now() - days * 86400000
      )
      .sort((a, b) => a.updatedAt - b.updatedAt);
    let total = 0n;
    return rows.map((r) => {
      total += BigInt(r.realizedNetProfit);
      return { ...r, total };
    });
  }, [status, borrowToken, range]);
  const values = [0n, ...data.map((r) => r.total)],
    min = values.reduce((a, b) => (a < b ? a : b)),
    max = values.reduce((a, b) => (a > b ? a : b)),
    span = max - min || 1n;
  const y = (value) => 190 - Number(((value - min) * 150000n) / span) / 1000;
  const points = values
      .map(
        (value, i) =>
          `${90 + (i / Math.max(1, values.length - 1)) * 610},${y(value)}`
      )
      .join(" "),
    zero = y(0n);
  return (
    <Panel
      title="Realized performance"
      subtitle={`Recent settled executions · ${symbol} · PAPER estimates are excluded`}
      action={
        <ToggleButtonGroup
          size="small"
          exclusive
          value={range}
          onChange={(_, value) => value && setRange(value)}
          aria-label="Performance time range"
        >
          {["24h", "7d", "30d", "all"].map((value) => (
            <ToggleButton key={value} value={value}>
              {value === "all" ? "All" : value}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      }
    >
      {data.length && Number.isInteger(decimals) ? (
        <>
          <Box
            sx={{ display: "flex", alignItems: "baseline", gap: 1.5, mb: 1 }}
          >
            <Typography
              variant="h4"
              sx={{
                color: data.at(-1).total >= 0n ? "success.main" : "error.main",
              }}
            >
              {formatUnits(data.at(-1).total, decimals)}
            </Typography>
            <Typography color="text.secondary">{symbol}</Typography>
            <Chip
              label={`${data.length} settled`}
              variant="outlined"
              sx={{ ml: "auto" }}
            />
          </Box>
          <Box sx={{ minHeight: 205 }}>
            <svg
              role="img"
              aria-label={`Cumulative realized net profit ${formatUnits(
                data.at(-1).total,
                decimals
              )} ${symbol}`}
              viewBox="0 0 740 225"
              style={{ width: "100%", display: "block" }}
            >
              <defs>
                <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#7ce9bf" stopOpacity=".16" />
                  <stop offset="100%" stopColor="#7ce9bf" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[40, 90, 140, 190].map((row, i) => (
                <g key={row}>
                  <line
                    x1="90"
                    x2="700"
                    y1={row}
                    y2={row}
                    stroke="#263345"
                    strokeDasharray="3 6"
                  />
                  <text
                    x="78"
                    textAnchor="end"
                    y={row + 4}
                    fill="#9caec4"
                    fontSize="10"
                  >
                    {formatUnits(max - (span * BigInt(i)) / 3n, decimals, 2)}
                  </text>
                </g>
              ))}
              <line
                x1="90"
                x2="700"
                y1={zero}
                y2={zero}
                stroke="#718198"
                strokeDasharray="4 6"
              />
              <polygon
                points={`90,${zero} ${points} 700,${zero}`}
                fill={`url(#${id})`}
              />
              <polyline
                points={points}
                fill="none"
                stroke={data.at(-1).total >= 0n ? "#7ce9bf" : "#ff929b"}
                strokeWidth="2.5"
                strokeLinejoin="round"
              />
              {data.map((r, i) => (
                <circle
                  key={r.id}
                  cx={90 + ((i + 1) / data.length) * 610}
                  cy={y(r.total)}
                  r="3"
                  fill={r.total >= 0n ? "#7ce9bf" : "#ff929b"}
                >
                  <title>
                    {time(r.updatedAt)} · {formatUnits(r.total, decimals)}{" "}
                    {symbol}
                  </title>
                </circle>
              ))}
              <text x="90" y="216" fill="#9caec4" fontSize="10">
                {time(data[0].updatedAt)}
              </text>
              <text
                x="700"
                y="216"
                fill="#9caec4"
                fontSize="10"
                textAnchor="end"
              >
                {time(data.at(-1).updatedAt)}
              </text>
            </svg>
          </Box>
          <Typography variant="caption" color="text.secondary">
            Chart uses the available execution window (up to 100 records). The
            account total includes all settled records.
          </Typography>
        </>
      ) : (
        <EmptyState
          icon={ShowChartRounded}
          title="Your realized history starts here"
          description="Settled LIVE executions will build this chart. PAPER simulations appear in the ledger with expected profit, without changing realized performance."
        />
      )}
    </Panel>
  );
}
