import React, { useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  CircularProgress,
  Alert,
  Divider,
  Grid,
  Paper,
  Chip,
} from "@mui/material";
import { simulateProfit } from "../services/api";

const SimulationDialog = ({ open, onClose }) => {
  const [formData, setFormData] = useState({
    borrowAmount: "10000",
    route: "DAI→WETH→USDC→DAI",
    slippageBips: "50",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSimulate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await simulateProfit({
        borrowAmount: formData.borrowAmount,
        route: formData.route,
        slippageBips: parseInt(formData.slippageBips, 10),
      });
      setResult(data);
    } catch (err) {
      setError(err.message || "Simulation failed");
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>Profit Simulation</DialogTitle>
      <DialogContent>
        <Box sx={{ mt: 2 }}>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={4}>
              <TextField
                fullWidth
                label="Borrow Amount (DAI)"
                name="borrowAmount"
                value={formData.borrowAmount}
                onChange={handleChange}
                type="number"
                inputProps={{ min: 0 }}
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField
                fullWidth
                label="Route"
                name="route"
                value={formData.route}
                onChange={handleChange}
                helperText="e.g., DAI→WETH→USDC→DAI"
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField
                fullWidth
                label="Slippage (bips)"
                name="slippageBips"
                value={formData.slippageBips}
                onChange={handleChange}
                type="number"
                inputProps={{ min: 0, max: 10000 }}
                helperText="1 bip = 0.01%"
              />
            </Grid>
          </Grid>

          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}

          {result && (
            <Box sx={{ mt: 3 }}>
              <Divider sx={{ mb: 2 }} />
              <Typography variant="h6" gutterBottom>
                Simulation Results
              </Typography>

              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <Paper sx={{ p: 2, bgcolor: "background.default" }}>
                    <Typography variant="subtitle2" color="text.secondary">
                      Gross Profit
                    </Typography>
                    <Typography variant="h5" color="primary">
                      {Number(result.grossProfit || 0).toFixed(4)} DAI
                    </Typography>
                  </Paper>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <Paper sx={{ p: 2, bgcolor: "background.default" }}>
                    <Typography variant="subtitle2" color="text.secondary">
                      Net Profit (after gas)
                    </Typography>
                    <Typography
                      variant="h5"
                      color={Number(result.netProfit) >= 0 ? "success.main" : "error.main"}
                    >
                      {Number(result.netProfit || 0).toFixed(4)} DAI
                    </Typography>
                  </Paper>
                </Grid>
              </Grid>

              <Box sx={{ mt: 2 }}>
                <Typography variant="subtitle2" gutterBottom>
                  Breakdown
                </Typography>
                <Grid container spacing={1}>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      Borrow Amount:
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2">
                      {result.borrowAmount || formData.borrowAmount} DAI
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      Flash Loan Fee:
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2">
                      {Number(result.flashloanFee || 0).toFixed(4)} DAI
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      Estimated Gas Cost:
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2">
                      {Number(result.gasCost || 0).toFixed(6)} ETH
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      Gas Cost (DAI):
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2">
                      {Number(result.gasCostDai || 0).toFixed(4)} DAI
                    </Typography>
                  </Grid>
                </Grid>
              </Box>

              {result.hops && result.hops.length > 0 && (
                <Box sx={{ mt: 2 }}>
                  <Typography variant="subtitle2" gutterBottom>
                    Swap Details
                  </Typography>
                  {result.hops.map((hop, idx) => (
                    <Paper key={idx} sx={{ p: 1.5, mb: 1, bgcolor: "background.default" }}>
                      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <Typography variant="body2">
                          {hop.tokenIn} → {hop.tokenOut}
                        </Typography>
                        <Chip label={hop.dex} size="small" variant="outlined" />
                      </Box>
                      <Typography variant="caption" color="text.secondary">
                        In: {Number(hop.amountIn).toFixed(4)} | Out: {Number(hop.amountOut).toFixed(4)}
                      </Typography>
                    </Paper>
                  ))}
                </Box>
              )}

              <Box sx={{ mt: 2 }}>
                <Chip
                  label={Number(result.netProfit) > 0 ? "PROFITABLE" : "NOT PROFITABLE"}
                  color={Number(result.netProfit) > 0 ? "success" : "error"}
                  sx={{ fontWeight: "bold" }}
                />
              </Box>
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Close</Button>
        <Button
          onClick={handleSimulate}
          variant="contained"
          disabled={loading}
          startIcon={loading ? <CircularProgress size={16} /> : null}
        >
          {loading ? "Simulating..." : "Run Simulation"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SimulationDialog;
