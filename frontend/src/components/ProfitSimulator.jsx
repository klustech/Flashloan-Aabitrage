import React, { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  MenuItem,
  Slider,
  TextField,
  Typography,
} from "@mui/material";
import {
  AddRounded,
  DeleteOutlineRounded,
  PlayArrowRounded,
  ScienceOutlined,
} from "@mui/icons-material";
import { simulateArbitrage } from "../services/api";
import { EmptyState, Metric, Panel } from "../ui/Primitives";
import { DEX_LABELS, number } from "../ui/format";
const TOKENS = [
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
];
const DEXES = [
  "uniswap_v2",
  "sushiswap",
  "uniswap_v3",
  "pancake_v3",
  "balancer",
  "curve",
];
export default function ProfitSimulator() {
  const [borrowAmount, setBorrowAmount] = useState("1000"),
    [borrowToken, setBorrowToken] = useState("DAI"),
    [slippageBps, setSlippageBps] = useState(30),
    [gasPrice, setGasPrice] = useState(30);
  const [route, setRoute] = useState([
    { tokenIn: "DAI", tokenOut: "WETH", dex: "uniswap_v2" },
    { tokenIn: "WETH", tokenOut: "DAI", dex: "sushiswap" },
  ]);
  const [loading, setLoading] = useState(false),
    [result, setResult] = useState(null),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false);
  const change = (setter, value) => {
    setter(value);
    if (result) setDirty(true);
  };
  const changeToken = (value) => {
    change(setBorrowToken, value);
    setRoute((prev) =>
      prev.map((hop, i) => ({
        ...hop,
        ...(i === 0 ? { tokenIn: value } : {}),
        ...(i === prev.length - 1 ? { tokenOut: value } : {}),
      }))
    );
  };
  const updateHop = (index, key, value) => {
    const next = route.map((h) => ({ ...h }));
    next[index][key] = value;
    if (key === "tokenOut" && index < next.length - 1)
      next[index + 1].tokenIn = value;
    if (key === "tokenIn" && index > 0) next[index - 1].tokenOut = value;
    change(setRoute, next);
  };
  const addHop = () => {
    if (route.length >= 4) return;
    const last = route.at(-1),
      middle = TOKENS.find(
        (t) => ![borrowToken, last.tokenIn].includes(t.symbol)
      ).symbol;
    change(setRoute, [
      ...route.slice(0, -1),
      { ...last, tokenOut: middle },
      { tokenIn: middle, tokenOut: borrowToken, dex: "uniswap_v3" },
    ]);
  };
  const removeHop = (index) => {
    if (route.length <= 2) return;
    const next = route.filter((_, i) => i !== index).map((h) => ({ ...h }));
    next[0].tokenIn = borrowToken;
    for (let i = 1; i < next.length; i++)
      next[i].tokenIn = next[i - 1].tokenOut;
    next.at(-1).tokenOut = borrowToken;
    change(setRoute, next);
  };
  const simulate = async (event) => {
    event.preventDefault();
    setError("");
    if (!Number.isFinite(Number(borrowAmount)) || Number(borrowAmount) <= 0) {
      setError("Enter a positive borrow amount.");
      return;
    }
    if (
      route.some((h) => h.tokenIn === h.tokenOut) ||
      route[0].tokenIn !== borrowToken ||
      route.at(-1).tokenOut !== borrowToken
    ) {
      setError(
        "Each swap needs different tokens, and the route must return to the borrow token."
      );
      return;
    }
    setLoading(true);
    setResult(null);
    setDirty(false);
    try {
      const response = await simulateArbitrage({
        borrowAmount: Number(borrowAmount),
        borrowToken,
        route: route.map((h) => ({
          ...h,
          tokenInAddress: TOKENS.find((t) => t.symbol === h.tokenIn).address,
          tokenOutAddress: TOKENS.find((t) => t.symbol === h.tokenOut).address,
        })),
        slippageBps,
        gasPrice,
      });
      setResult(response);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "Simulation failed");
    } finally {
      setLoading(false);
    }
  };
  const simulation = result?.simulation,
    currency = simulation?.borrowToken || borrowToken;
  return (
    <Box sx={{ display: "grid", gap: 3 }}>
      <Alert severity="info">
        Illustrative scenario tool. This API uses approximate economics; it does
        not obtain executable pool quotes or simulate the production executor.
        Use PAPER records to inspect on-chain validation.
      </Alert>
      <Box className="dashboard-split">
        <Box
          component="form"
          onSubmit={simulate}
          sx={{ display: "grid", gap: 3 }}
        >
          <Panel
            title="Borrow & costs"
            subtitle="Choose the input amount and assumed transaction costs."
          >
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)",
                gap: 2,
              }}
            >
              <TextField
                fullWidth
                size="small"
                label="Borrow amount"
                type="number"
                value={borrowAmount}
                onChange={(e) => change(setBorrowAmount, e.target.value)}
                inputProps={{ min: 0, step: "any" }}
              />
              <TextField
                select
                fullWidth
                size="small"
                label="Borrow token"
                value={borrowToken}
                onChange={(e) => changeToken(e.target.value)}
              >
                {TOKENS.map((t) => (
                  <MenuItem key={t.symbol} value={t.symbol}>
                    {t.symbol}
                  </MenuItem>
                ))}
              </TextField>
            </Box>
            <Box sx={{ mt: 3 }}>
              <Box sx={{ display: "flex", justifyContent: "space-between" }}>
                <Typography variant="body2" color="text.secondary">
                  Slippage tolerance
                </Typography>
                <Typography variant="body2">{slippageBps / 100}%</Typography>
              </Box>
              <Slider
                aria-label="Slippage tolerance"
                value={slippageBps}
                onChange={(_, v) => change(setSlippageBps, v)}
                min={0}
                max={300}
                step={10}
                size="small"
                valueLabelDisplay="auto"
              />
            </Box>
            <Box sx={{ mt: 2 }}>
              <Box sx={{ display: "flex", justifyContent: "space-between" }}>
                <Typography variant="body2" color="text.secondary">
                  Assumed gas price
                </Typography>
                <Typography variant="body2">{gasPrice} gwei</Typography>
              </Box>
              <Slider
                aria-label="Assumed gas price"
                value={gasPrice}
                onChange={(_, v) => change(setGasPrice, v)}
                min={0}
                max={200}
                step={5}
                size="small"
                valueLabelDisplay="auto"
              />
            </Box>
          </Panel>
          <Panel
            title="Route builder"
            subtitle="The output of each swap becomes the next swap's input."
            action={
              <Button
                type="button"
                size="small"
                startIcon={<AddRounded />}
                onClick={addHop}
                disabled={route.length >= 4}
              >
                Add swap
              </Button>
            }
          >
            <Box sx={{ display: "grid", gap: 2 }}>
              {route.map((hop, i) => (
                <Box
                  key={i}
                  sx={{
                    p: 2,
                    bgcolor: "background.default",
                    borderRadius: 2,
                    border: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      mb: 2,
                    }}
                  >
                    <Chip label={`Swap ${i + 1}`} variant="outlined" />
                    {route.length > 2 && (
                      <Button
                        type="button"
                        size="small"
                        color="error"
                        aria-label={`Remove swap ${i + 1}`}
                        startIcon={<DeleteOutlineRounded />}
                        onClick={() => removeHop(i)}
                      >
                        Remove
                      </Button>
                    )}
                  </Box>
                  <Box
                    sx={{
                      display: "grid",
                      gridTemplateColumns: {
                        xs: "repeat(2,minmax(0,1fr))",
                        sm: "1fr 1fr 1.4fr",
                      },
                      gap: 1.5,
                    }}
                  >
                    {[
                      ["tokenIn", "Input token"],
                      ["tokenOut", "Output token"],
                    ].map(([key, label]) => (
                      <TextField
                        select
                        size="small"
                        key={key}
                        label={`${label} ${i + 1}`}
                        value={hop[key]}
                        disabled={
                          (key === "tokenIn" && i === 0) ||
                          (key === "tokenOut" && i === route.length - 1)
                        }
                        onChange={(e) => updateHop(i, key, e.target.value)}
                      >
                        {TOKENS.map((t) => (
                          <MenuItem key={t.symbol} value={t.symbol}>
                            {t.symbol}
                          </MenuItem>
                        ))}
                      </TextField>
                    ))}
                    <TextField
                      select
                      size="small"
                      label={`Venue ${i + 1}`}
                      value={hop.dex}
                      onChange={(e) => updateHop(i, "dex", e.target.value)}
                      sx={{ gridColumn: { xs: "span 2", sm: "auto" } }}
                    >
                      {DEXES.map((dex) => (
                        <MenuItem key={dex} value={dex}>
                          {DEX_LABELS[dex]}
                          {["balancer", "curve"].includes(dex)
                            ? " · legacy"
                            : ""}
                        </MenuItem>
                      ))}
                    </TextField>
                  </Box>
                </Box>
              ))}
            </Box>
            {error && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {error}
              </Alert>
            )}
            <Button
              type="submit"
              fullWidth
              variant="contained"
              startIcon={<PlayArrowRounded />}
              disabled={loading}
              sx={{ mt: 3 }}
            >
              {loading
                ? "Calculating scenario…"
                : "Run illustrative simulation"}
            </Button>
          </Panel>
        </Box>
        <Panel
          title="Scenario results"
          subtitle="Estimates from the manual simulator, separate from production trading."
          sx={{ alignSelf: "start" }}
        >
          {loading ? (
            <EmptyState
              icon={ScienceOutlined}
              title="Calculating scenario"
              description="Applying the selected route and cost assumptions."
            />
          ) : !simulation ? (
            <EmptyState
              icon={ScienceOutlined}
              title="Build a route to get started"
              description="Enter a borrow amount, choose venues and run the scenario. No trade will be signed or submitted."
            />
          ) : (
            <>
              <Chip
                label="ILLUSTRATIVE · NOT EXECUTABLE"
                variant="outlined"
                color="info"
                sx={{ mb: 2 }}
              />
              {dirty && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  Inputs changed. Run again to update these results.
                </Alert>
              )}
              <Box sx={{ display: "grid", gap: 2 }}>
                <Metric
                  label="Projected net profit"
                  value={number(simulation.netProfit, 4)}
                  unit={currency}
                  hint="Approximate costs; not a production quote"
                  color={
                    Number(simulation.netProfit) >= 0
                      ? "success.main"
                      : "error.main"
                  }
                />
                <Box sx={{ display: "grid", gap: 1.5, my: 1 }}>
                  {[
                    [
                      "Borrow amount",
                      number(simulation.borrowAmount, 4),
                      currency,
                    ],
                    [
                      "Expected return",
                      number(simulation.expectedReturn, 4),
                      currency,
                    ],
                    [
                      "Gross difference",
                      number(simulation.grossProfit, 4),
                      currency,
                    ],
                    ["Gas cost", number(simulation.gasCost, 6), "ETH"],
                    ["Price impact", number(simulation.priceImpact, 4), "%"],
                  ].map(([label, value, unit]) => (
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
                      <Typography variant="body2">
                        {value} {unit}
                      </Typography>
                    </Box>
                  ))}
                </Box>
                {simulation.hops?.map((hop, i) => (
                  <Box
                    key={i}
                    sx={{
                      p: 1.5,
                      bgcolor: "background.default",
                      borderRadius: 2,
                    }}
                  >
                    <Typography variant="body2">
                      {i + 1}. {hop.tokenIn} → {hop.tokenOut}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {DEX_LABELS[hop.dex] || hop.dex} · impact{" "}
                      {hop.priceImpact}%
                    </Typography>
                  </Box>
                ))}
              </Box>
            </>
          )}
        </Panel>
      </Box>
    </Box>
  );
}
