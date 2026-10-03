import React, { useState } from "react";
import {
  Box,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Typography,
} from "@mui/material";
import { EmptyState } from "../ui/Primitives";
import { DEX_LABELS, number } from "../ui/format";
export default function OpportunitiesTable({ opportunities = [] }) {
  const [page, setPage] = useState(0),
    [rowsPerPage, setRowsPerPage] = useState(10);
  if (!opportunities.length)
    return (
      <EmptyState
        compact
        title="No legacy candidates"
        description="Production simulations remain available in the execution ledger."
      />
    );
  return (
    <Box>
      <TableContainer>
        <Table size="small" aria-label="Legacy route diagnostics">
          <TableHead>
            <TableRow>
              <TableCell>Route</TableCell>
              <TableCell>Venues</TableCell>
              <TableCell align="right">Estimated net (DAI)</TableCell>
              <TableCell align="right">Gas estimate (DAI)</TableCell>
              <TableCell align="right">ML score</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {opportunities
              .slice(page * rowsPerPage, (page + 1) * rowsPerPage)
              .map((row, i) => (
                <TableRow key={row.id || i}>
                  <TableCell sx={{ minWidth: 220 }}>
                    <Typography variant="body2">
                      {row.route || "Route unavailable"}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: "flex", gap: 0.6, flexWrap: "wrap" }}>
                      {(row.dexes || row.hops?.map((h) => h.dex) || []).map(
                        (dex, j) => (
                          <Chip
                            key={j}
                            label={DEX_LABELS[dex] || dex}
                            variant="outlined"
                          />
                        )
                      )}
                    </Box>
                  </TableCell>
                  <TableCell align="right">
                    {number(row.netProfit ?? row.estimatedProfit, 4)}
                  </TableCell>
                  <TableCell align="right">
                    {number(row.gasCostDai, 4)}
                  </TableCell>
                  <TableCell align="right">
                    {row.mlScore == null
                      ? "—"
                      : `${number(row.mlScore * 100, 1)}%`}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination
        component="div"
        count={opportunities.length}
        page={Math.min(
          page,
          Math.max(0, Math.ceil(opportunities.length / rowsPerPage) - 1)
        )}
        onPageChange={(_, value) => setPage(value)}
        rowsPerPage={rowsPerPage}
        onRowsPerPageChange={(e) => {
          setRowsPerPage(Number(e.target.value));
          setPage(0);
        }}
        rowsPerPageOptions={[5, 10, 25]}
      />
    </Box>
  );
}
