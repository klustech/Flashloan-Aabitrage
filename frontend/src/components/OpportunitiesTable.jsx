import React, { useEffect, useState } from "react";
import {
  Box,
  Paper,
  Typography,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Chip,
  CircularProgress,
  IconButton,
  Tooltip,
  TablePagination,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TrendingDownIcon from "@mui/icons-material/TrendingDown";
import { getOpportunities } from "../services/api";

const OpportunitiesTable = () => {
  const [opportunities, setOpportunities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [lastUpdate, setLastUpdate] = useState(null);

  const fetchOpportunities = async () => {
    setLoading(true);
    try {
      const data = await getOpportunities();
      setOpportunities(Array.isArray(data) ? data : []);
      setLastUpdate(new Date());
    } catch (err) {
      console.error("Failed to fetch opportunities:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOpportunities();
    const interval = setInterval(fetchOpportunities, 15000); // Refresh every 15s
    return () => clearInterval(interval);
  }, []);

  const handleChangePage = (event, newPage) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const formatProfit = (profit) => {
    const value = Number(profit);
    if (!Number.isFinite(value)) return "-";
    return value.toFixed(4);
  };

  const getDexColor = (dex) => {
    const colors = {
      uniswap_v2: "#FF007A",
      uniswap_v3: "#FF007A",
      sushiswap: "#FA52A0",
      balancer: "#1E1E1E",
      curve: "#3465A4",
    };
    return colors[dex?.toLowerCase()] || "#666";
  };

  const paginatedData = opportunities.slice(
    page * rowsPerPage,
    page * rowsPerPage + rowsPerPage
  );

  return (
    <Paper sx={{ p: 2, mb: 3 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 2 }}>
        <Typography variant="h6" color="primary">
          Live Arbitrage Opportunities
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          {lastUpdate && (
            <Typography variant="caption" color="text.secondary">
              Updated: {lastUpdate.toLocaleTimeString()}
            </Typography>
          )}
          <Tooltip title="Refresh">
            <IconButton onClick={fetchOpportunities} disabled={loading} size="small">
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {loading && opportunities.length === 0 ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <CircularProgress />
        </Box>
      ) : opportunities.length === 0 ? (
        <Typography color="text.secondary" sx={{ textAlign: "center", py: 4 }}>
          No opportunities found at the moment.
        </Typography>
      ) : (
        <>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ color: "primary.main" }}>Route</TableCell>
                <TableCell sx={{ color: "primary.main" }}>DEXes</TableCell>
                <TableCell sx={{ color: "primary.main" }} align="right">Est. Profit (DAI)</TableCell>
                <TableCell sx={{ color: "primary.main" }} align="right">ML Score</TableCell>
                <TableCell sx={{ color: "primary.main" }} align="right">Gas Cost</TableCell>
                <TableCell sx={{ color: "primary.main" }}>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {paginatedData.map((opp, idx) => {
                const profit = Number(opp.estimatedProfit);
                const isProfitable = profit > 0;

                return (
                  <TableRow key={opp.id || idx} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                        {opp.route || "-"}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                        {(opp.dexes || []).map((dex, i) => (
                          <Chip
                            key={i}
                            label={dex}
                            size="small"
                            sx={{
                              backgroundColor: getDexColor(dex),
                              color: "white",
                              fontSize: "0.7rem",
                            }}
                          />
                        ))}
                      </Box>
                    </TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 0.5 }}>
                        {isProfitable ? (
                          <TrendingUpIcon sx={{ color: "success.main", fontSize: 16 }} />
                        ) : (
                          <TrendingDownIcon sx={{ color: "error.main", fontSize: 16 }} />
                        )}
                        <Typography
                          variant="body2"
                          sx={{ color: isProfitable ? "success.main" : "error.main" }}
                        >
                          {formatProfit(opp.estimatedProfit)}
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell align="right">
                      <Chip
                        label={`${((opp.mlScore || 0) * 100).toFixed(0)}%`}
                        size="small"
                        color={opp.mlScore > 0.7 ? "success" : opp.mlScore > 0.4 ? "warning" : "default"}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2">
                        {opp.gasCost ? `${Number(opp.gasCost).toFixed(4)} ETH` : "-"}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={opp.status || "pending"}
                        size="small"
                        color={
                          opp.status === "executed" ? "success" :
                          opp.status === "skipped" ? "warning" :
                          opp.status === "failed" ? "error" : "default"
                        }
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={opportunities.length}
            page={page}
            onPageChange={handleChangePage}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={handleChangeRowsPerPage}
            rowsPerPageOptions={[5, 10, 25]}
          />
        </>
      )}
    </Paper>
  );
};

export default OpportunitiesTable;
