import React, { useState, useEffect } from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  Grid,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Tooltip,
  IconButton,
  Collapse,
  Badge,
} from "@mui/material";
import {
  TrendingUp,
  TrendingDown,
  SwapHoriz,
  ExpandMore,
  ExpandLess,
  Refresh,
  Star,
} from "@mui/icons-material";
import { getOpportunities } from "../services/api";

// DEX colors for visualization
const DEX_COLORS = {
  uniswap_v2: "#FF007A",
  uniswap_v3: "#FC72FF",
  sushiswap: "#0E0F23",
  balancer: "#1E1E1E",
  curve: "#A5A4CE",
};

const DEX_LABELS = {
  uniswap_v2: "Uni V2",
  uniswap_v3: "Uni V3",
  sushiswap: "Sushi",
  balancer: "Balancer",
  curve: "Curve",
};

const RouteVisualization = () => {
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedRoute, setExpandedRoute] = useState(null);
  const [sortBy, setSortBy] = useState("profit");

  const fetchRoutes = async () => {
    try {
      setLoading(true);
      const data = await getOpportunities();
      setRoutes(data.opportunities || []);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to fetch routes");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRoutes();
    const interval = setInterval(fetchRoutes, 10000);
    return () => clearInterval(interval);
  }, []);

  const sortedRoutes = [...routes].sort((a, b) => {
    switch (sortBy) {
      case "profit":
        return parseFloat(b.estimatedProfit || 0) - parseFloat(a.estimatedProfit || 0);
      case "hops":
        return (a.hops?.length || 0) - (b.hops?.length || 0);
      case "liquidity":
        return parseFloat(b.liquidity || 0) - parseFloat(a.liquidity || 0);
      default:
        return 0;
    }
  });

  const formatProfit = (profit) => {
    const num = parseFloat(profit || 0);
    if (num >= 0) {
      return `+${num.toFixed(4)}`;
    }
    return num.toFixed(4);
  };

  const renderRouteFlow = (route) => {
    if (!route.hops || route.hops.length === 0) return null;

    return (
      <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
        {route.hops.map((hop, idx) => (
          <React.Fragment key={idx}>
            <Chip
              label={hop.tokenIn?.symbol || hop.tokenA?.slice(0, 8)}
              size="small"
              variant="outlined"
            />
            <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <SwapHoriz fontSize="small" color="action" />
              <Chip
                label={DEX_LABELS[hop.dex] || hop.dex}
                size="small"
                sx={{
                  backgroundColor: DEX_COLORS[hop.dex] || "#666",
                  color: "white",
                  fontSize: "0.65rem",
                  height: "18px",
                }}
              />
            </Box>
            {idx === route.hops.length - 1 && (
              <Chip
                label={hop.tokenOut?.symbol || hop.tokenB?.slice(0, 8)}
                size="small"
                variant="outlined"
              />
            )}
          </React.Fragment>
        ))}
      </Box>
    );
  };

  if (loading && routes.length === 0) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Route Candidates
          </Typography>
          <LinearProgress />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 2 }}>
          <Typography variant="h6">
            Route Candidates
            <Badge badgeContent={routes.length} color="primary" sx={{ ml: 2 }} />
          </Typography>
          <Box>
            <Chip
              label="By Profit"
              onClick={() => setSortBy("profit")}
              color={sortBy === "profit" ? "primary" : "default"}
              size="small"
              sx={{ mr: 1 }}
            />
            <Chip
              label="By Hops"
              onClick={() => setSortBy("hops")}
              color={sortBy === "hops" ? "primary" : "default"}
              size="small"
              sx={{ mr: 1 }}
            />
            <IconButton onClick={fetchRoutes} size="small">
              <Refresh />
            </IconButton>
          </Box>
        </Box>

        {error && (
          <Typography color="error" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}

        <TableContainer component={Paper} sx={{ maxHeight: 400 }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                <TableCell width={40}></TableCell>
                <TableCell>Route</TableCell>
                <TableCell align="right">Est. Profit</TableCell>
                <TableCell align="right">Gas Cost</TableCell>
                <TableCell align="right">Net</TableCell>
                <TableCell align="center">ML Score</TableCell>
                <TableCell align="center">Hops</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedRoutes.map((route, idx) => (
                <React.Fragment key={route.id || idx}>
                  <TableRow
                    hover
                    onClick={() => setExpandedRoute(expandedRoute === idx ? null : idx)}
                    sx={{ cursor: "pointer" }}
                  >
                    <TableCell>
                      {idx === 0 && <Star fontSize="small" color="warning" />}
                      {expandedRoute === idx ? <ExpandLess /> : <ExpandMore />}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" noWrap sx={{ maxWidth: 200 }}>
                        {route.route || route.routeTokens?.join(" → ") || "N/A"}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography
                        variant="body2"
                        color={parseFloat(route.estimatedProfit) >= 0 ? "success.main" : "error.main"}
                      >
                        {formatProfit(route.estimatedProfit)} DAI
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2" color="text.secondary">
                        {parseFloat(route.gasCostDai || 0).toFixed(4)} DAI
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                        {parseFloat(route.netProfit) >= 0 ? (
                          <TrendingUp fontSize="small" color="success" />
                        ) : (
                          <TrendingDown fontSize="small" color="error" />
                        )}
                        <Typography
                          variant="body2"
                          color={parseFloat(route.netProfit) >= 0 ? "success.main" : "error.main"}
                          sx={{ ml: 0.5 }}
                        >
                          {formatProfit(route.netProfit)} DAI
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title="ML Prediction Score">
                        <Chip
                          label={route.mlScore ? `${(route.mlScore * 100).toFixed(0)}%` : "N/A"}
                          size="small"
                          color={route.mlScore > 0.7 ? "success" : route.mlScore > 0.4 ? "warning" : "default"}
                        />
                      </Tooltip>
                    </TableCell>
                    <TableCell align="center">
                      <Chip label={route.hops?.length || "?"} size="small" />
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={7} sx={{ py: 0, borderBottom: expandedRoute === idx ? 1 : 0 }}>
                      <Collapse in={expandedRoute === idx} timeout="auto" unmountOnExit>
                        <Box sx={{ p: 2, bgcolor: "background.default" }}>
                          <Typography variant="subtitle2" gutterBottom>
                            Route Flow
                          </Typography>
                          {renderRouteFlow(route)}

                          <Grid container spacing={2} sx={{ mt: 1 }}>
                            <Grid item xs={4}>
                              <Typography variant="caption" color="text.secondary">
                                Borrow Amount
                              </Typography>
                              <Typography variant="body2">
                                {parseFloat(route.borrowAmount || 0).toFixed(2)} DAI
                              </Typography>
                            </Grid>
                            <Grid item xs={4}>
                              <Typography variant="caption" color="text.secondary">
                                Liquidity
                              </Typography>
                              <Typography variant="body2">
                                ${parseFloat(route.liquidity || 0).toLocaleString()}
                              </Typography>
                            </Grid>
                            <Grid item xs={4}>
                              <Typography variant="caption" color="text.secondary">
                                Volatility
                              </Typography>
                              <Typography variant="body2">
                                {(route.volatility || 0).toFixed(2)}%
                              </Typography>
                            </Grid>
                          </Grid>

                          {route.hops && (
                            <Box sx={{ mt: 2 }}>
                              <Typography variant="subtitle2" gutterBottom>
                                Swap Details
                              </Typography>
                              {route.hops.map((hop, hopIdx) => (
                                <Box
                                  key={hopIdx}
                                  sx={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    p: 1,
                                    bgcolor: "background.paper",
                                    borderRadius: 1,
                                    mb: 0.5,
                                  }}
                                >
                                  <Typography variant="caption">
                                    {hopIdx + 1}. {hop.tokenA?.slice(0, 8)} → {hop.tokenB?.slice(0, 8)}
                                  </Typography>
                                  <Chip
                                    label={DEX_LABELS[hop.dex] || hop.dex}
                                    size="small"
                                    sx={{ height: 20 }}
                                  />
                                  <Typography variant="caption" color="text.secondary">
                                    Pool: {hop.poolAddress?.slice(0, 10)}...
                                  </Typography>
                                </Box>
                              ))}
                            </Box>
                          )}
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </React.Fragment>
              ))}
              {sortedRoutes.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center">
                    <Typography color="text.secondary">No routes found</Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </CardContent>
    </Card>
  );
};

export default RouteVisualization;
