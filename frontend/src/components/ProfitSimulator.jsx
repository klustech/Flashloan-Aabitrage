import React, { useState, useCallback } from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Grid,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Slider,
  Paper,
  Divider,
  Chip,
  CircularProgress,
  Alert,
  Tooltip,
  IconButton,
} from "@mui/material";
import {
  Calculate,
  TrendingUp,
  TrendingDown,
  LocalGasStation,
  SwapHoriz,
  Info,
  Refresh,
} from "@mui/icons-material";
import { simulateArbitrage } from "../services/api";

const TOKENS = [
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EesaDCAE", decimals: 18 },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
];

const DEXES = ["uniswap_v2", "uniswap_v3", "sushiswap", "balancer", "curve"];

const DEX_LABELS = {
  uniswap_v2: "Uniswap V2",
  uniswap_v3: "Uniswap V3",
  sushiswap: "SushiSwap",
  balancer: "Balancer",
  curve: "Curve",
};

const ProfitSimulator = () => {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Simulation parameters
  const [borrowAmount, setBorrowAmount] = useState("1000");
  const [borrowToken, setBorrowToken] = useState("DAI");
  const [route, setRoute] = useState([
    { tokenIn: "DAI", tokenOut: "WETH", dex: "uniswap_v2" },
    { tokenIn: "WETH", tokenOut: "USDC", dex: "uniswap_v3" },
    { tokenIn: "USDC", tokenOut: "DAI", dex: "curve" },
  ]);
  const [slippageBps, setSlippageBps] = useState(50); // 0.5%
  const [gasPrice, setGasPrice] = useState(30); // Gwei

  const addHop = () => {
    if (route.length < 4) {
      const lastToken = route[route.length - 1]?.tokenOut || borrowToken;
      setRoute([...route, { tokenIn: lastToken, tokenOut: borrowToken, dex: "uniswap_v2" }]);
    }
  };

  const removeHop = (index) => {
    if (route.length > 2) {
      setRoute(route.filter((_, i) => i !== index));
    }
  };

  const updateHop = (index, field, value) => {
    const newRoute = [...route];
    newRoute[index] = { ...newRoute[index], [field]: value };

    // Auto-chain token connections
    if (field === "tokenOut" && index < route.length - 1) {
      newRoute[index + 1] = { ...newRoute[index + 1], tokenIn: value };
    }
    if (field === "tokenIn" && index > 0) {
      newRoute[index - 1] = { ...newRoute[index - 1], tokenOut: value };
    }

    setRoute(newRoute);
  };

  const runSimulation = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const params = {
        borrowAmount: parseFloat(borrowAmount),
        borrowToken,
        route: route.map(hop => ({
          ...hop,
          tokenInAddress: TOKENS.find(t => t.symbol === hop.tokenIn)?.address,
          tokenOutAddress: TOKENS.find(t => t.symbol === hop.tokenOut)?.address,
        })),
        slippageBps,
        gasPrice,
      };

      const response = await simulateArbitrage(params);
      setResult(response);
    } catch (err) {
      // Show actual error instead of mock data
      const errorMessage = err.response?.data?.error || err.message || "Simulation failed";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (value, decimals = 4) => {
    return parseFloat(value || 0).toFixed(decimals);
  };

  return (
    <Card>
      <CardContent>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 3 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Calculate color="primary" />
            <Typography variant="h6">Profit Simulator</Typography>
          </Box>
          <Tooltip title="Simulate arbitrage routes before execution">
            <IconButton size="small">
              <Info />
            </IconButton>
          </Tooltip>
        </Box>

        <Grid container spacing={3}>
          {/* Input Parameters */}
          <Grid item xs={12} md={6}>
            <Paper sx={{ p: 2, bgcolor: "background.default" }}>
              <Typography variant="subtitle2" gutterBottom>
                Borrow Parameters
              </Typography>

              <Grid container spacing={2}>
                <Grid item xs={8}>
                  <TextField
                    fullWidth
                    label="Borrow Amount"
                    type="number"
                    value={borrowAmount}
                    onChange={(e) => setBorrowAmount(e.target.value)}
                    size="small"
                    InputProps={{
                      inputProps: { min: 0 },
                    }}
                  />
                </Grid>
                <Grid item xs={4}>
                  <FormControl fullWidth size="small">
                    <InputLabel>Token</InputLabel>
                    <Select
                      value={borrowToken}
                      label="Token"
                      onChange={(e) => setBorrowToken(e.target.value)}
                    >
                      {TOKENS.map((token) => (
                        <MenuItem key={token.symbol} value={token.symbol}>
                          {token.symbol}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>
              </Grid>

              <Box sx={{ mt: 3 }}>
                <Typography variant="caption" color="text.secondary" gutterBottom>
                  Slippage Tolerance: {(slippageBps / 100).toFixed(2)}%
                </Typography>
                <Slider
                  value={slippageBps}
                  onChange={(_, value) => setSlippageBps(value)}
                  min={10}
                  max={300}
                  step={10}
                  marks={[
                    { value: 50, label: "0.5%" },
                    { value: 100, label: "1%" },
                    { value: 200, label: "2%" },
                  ]}
                  size="small"
                />
              </Box>

              <Box sx={{ mt: 2 }}>
                <Typography variant="caption" color="text.secondary" gutterBottom>
                  Gas Price: {gasPrice} Gwei
                </Typography>
                <Slider
                  value={gasPrice}
                  onChange={(_, value) => setGasPrice(value)}
                  min={10}
                  max={200}
                  step={5}
                  marks={[
                    { value: 30, label: "30" },
                    { value: 100, label: "100" },
                    { value: 200, label: "200" },
                  ]}
                  size="small"
                />
              </Box>
            </Paper>

            {/* Route Builder */}
            <Paper sx={{ p: 2, bgcolor: "background.default", mt: 2 }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 2 }}>
                <Typography variant="subtitle2">Route Configuration</Typography>
                <Button
                  size="small"
                  onClick={addHop}
                  disabled={route.length >= 4}
                >
                  Add Hop
                </Button>
              </Box>

              {route.map((hop, idx) => (
                <Box key={idx} sx={{ mb: 2 }}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
                    <Chip label={`Hop ${idx + 1}`} size="small" />
                    {route.length > 2 && (
                      <Button
                        size="small"
                        color="error"
                        onClick={() => removeHop(idx)}
                        sx={{ minWidth: "auto", p: 0.5 }}
                      >
                        Remove
                      </Button>
                    )}
                  </Box>
                  <Grid container spacing={1} alignItems="center">
                    <Grid item xs={3}>
                      <FormControl fullWidth size="small">
                        <InputLabel>In</InputLabel>
                        <Select
                          value={hop.tokenIn}
                          label="In"
                          onChange={(e) => updateHop(idx, "tokenIn", e.target.value)}
                        >
                          {TOKENS.map((t) => (
                            <MenuItem key={t.symbol} value={t.symbol}>
                              {t.symbol}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Grid>
                    <Grid item xs={1} sx={{ textAlign: "center" }}>
                      <SwapHoriz color="action" />
                    </Grid>
                    <Grid item xs={3}>
                      <FormControl fullWidth size="small">
                        <InputLabel>Out</InputLabel>
                        <Select
                          value={hop.tokenOut}
                          label="Out"
                          onChange={(e) => updateHop(idx, "tokenOut", e.target.value)}
                        >
                          {TOKENS.map((t) => (
                            <MenuItem key={t.symbol} value={t.symbol}>
                              {t.symbol}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Grid>
                    <Grid item xs={5}>
                      <FormControl fullWidth size="small">
                        <InputLabel>DEX</InputLabel>
                        <Select
                          value={hop.dex}
                          label="DEX"
                          onChange={(e) => updateHop(idx, "dex", e.target.value)}
                        >
                          {DEXES.map((dex) => (
                            <MenuItem key={dex} value={dex}>
                              {DEX_LABELS[dex]}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Grid>
                  </Grid>
                </Box>
              ))}

              <Button
                fullWidth
                variant="contained"
                onClick={runSimulation}
                disabled={loading}
                startIcon={loading ? <CircularProgress size={20} /> : <Calculate />}
                sx={{ mt: 2 }}
              >
                {loading ? "Simulating..." : "Run Simulation"}
              </Button>
            </Paper>
          </Grid>

          {/* Results */}
          <Grid item xs={12} md={6}>
            <Paper sx={{ p: 2, bgcolor: "background.default", minHeight: 400 }}>
              <Typography variant="subtitle2" gutterBottom>
                Simulation Results
              </Typography>

              {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {error}
                </Alert>
              )}

              {!result && !loading && (
                <Box sx={{ textAlign: "center", py: 4, color: "text.secondary" }}>
                  <Calculate sx={{ fontSize: 48, opacity: 0.5, mb: 2 }} />
                  <Typography>
                    Configure your route and click "Run Simulation" to see expected results
                  </Typography>
                </Box>
              )}

              {result?.simulation && (
                <>
                  {/* Profit Summary */}
                  <Grid container spacing={2} sx={{ mb: 3 }}>
                    <Grid item xs={6}>
                      <Paper sx={{ p: 2, textAlign: "center", bgcolor: "background.paper" }}>
                        <Typography variant="caption" color="text.secondary">
                          Gross Profit
                        </Typography>
                        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 0.5 }}>
                          <TrendingUp color="success" />
                          <Typography variant="h6" color="success.main">
                            +{formatCurrency(result.simulation.grossProfit)} {borrowToken}
                          </Typography>
                        </Box>
                      </Paper>
                    </Grid>
                    <Grid item xs={6}>
                      <Paper sx={{ p: 2, textAlign: "center", bgcolor: "background.paper" }}>
                        <Typography variant="caption" color="text.secondary">
                          Gas Cost
                        </Typography>
                        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 0.5 }}>
                          <LocalGasStation color="action" />
                          <Typography variant="h6">
                            {formatCurrency(result.simulation.gasCost)} ETH
                          </Typography>
                        </Box>
                      </Paper>
                    </Grid>
                  </Grid>

                  {/* Net Profit Highlight */}
                  <Paper
                    sx={{
                      p: 2,
                      textAlign: "center",
                      bgcolor: parseFloat(result.simulation.netProfit) > 0 ? "success.dark" : "error.dark",
                      color: "white",
                      mb: 3,
                    }}
                  >
                    <Typography variant="caption">Net Profit</Typography>
                    <Typography variant="h4">
                      {parseFloat(result.simulation.netProfit) >= 0 ? "+" : ""}
                      {formatCurrency(result.simulation.netProfit)} {borrowToken}
                    </Typography>
                    <Typography variant="caption">
                      ML Score: {((result.simulation.mlScore || 0) * 100).toFixed(0)}%
                    </Typography>
                  </Paper>

                  {/* Detailed Breakdown */}
                  <Typography variant="subtitle2" gutterBottom>
                    Swap Details
                  </Typography>
                  {result.simulation.hops?.map((hop, idx) => (
                    <Box
                      key={idx}
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        p: 1,
                        bgcolor: "background.paper",
                        borderRadius: 1,
                        mb: 1,
                      }}
                    >
                      <Box>
                        <Typography variant="body2">
                          {hop.tokenIn} → {hop.tokenOut}
                        </Typography>
                        <Chip label={DEX_LABELS[hop.dex]} size="small" sx={{ mt: 0.5 }} />
                      </Box>
                      <Typography variant="caption" color="text.secondary">
                        Impact: {hop.priceImpact}%
                      </Typography>
                    </Box>
                  ))}

                  {/* Warnings */}
                  {parseFloat(result.simulation.priceImpact) > 0.5 && (
                    <Alert severity="warning" sx={{ mt: 2 }}>
                      High price impact detected ({result.simulation.priceImpact}%). Consider reducing borrow amount.
                    </Alert>
                  )}

                  {parseFloat(result.simulation.netProfit) < 0 && (
                    <Alert severity="error" sx={{ mt: 2 }}>
                      This trade is projected to be unprofitable. Review your route configuration.
                    </Alert>
                  )}
                </>
              )}
            </Paper>
          </Grid>
        </Grid>
      </CardContent>
    </Card>
  );
};

export default ProfitSimulator;
