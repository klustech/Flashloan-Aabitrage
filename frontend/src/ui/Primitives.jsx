import React, { useState } from "react";
import {
  Box,
  Paper,
  Typography,
  Chip,
  Tooltip,
  IconButton,
  Snackbar,
} from "@mui/material";
import {
  ContentCopyRounded,
  ArrowForwardRounded,
  RadarRounded,
} from "@mui/icons-material";
import { DEX_LABELS, shortAddress, statusColor } from "./format";

export function Panel({ title, subtitle, action, children, sx, ...props }) {
  return (
    <Paper sx={{ p: { xs: 2.25, md: 3 }, minWidth: 0, ...sx }} {...props}>
      {title && (
        <Box className="panel-heading">
          <Box>
            <Typography variant="h6">{title}</Typography>
            {subtitle && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 0.4 }}
              >
                {subtitle}
              </Typography>
            )}
          </Box>
          {action}
        </Box>
      )}
      {children}
    </Paper>
  );
}
export function Metric({ label, value, unit, hint, icon: Icon, color, sx }) {
  return (
    <Paper sx={{ p: { xs: 2, md: 2.5 }, minWidth: 0, ...sx }}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          gap: 1,
          alignItems: "center",
          mb: 2,
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        {Icon && (
          <Icon sx={{ fontSize: 19, color: color || "text.secondary" }} />
        )}
      </Box>
      <Typography
        sx={{
          fontSize: { xs: "1.5rem", md: "1.8rem" },
          fontWeight: 600,
          letterSpacing: "-.04em",
          color: color || "text.primary",
          overflowWrap: "anywhere",
        }}
      >
        {value ?? "—"}
        {unit && (
          <Box
            component="span"
            sx={{
              ml: 0.7,
              fontSize: ".75rem",
              fontWeight: 450,
              color: "text.secondary",
              letterSpacing: 0,
            }}
          >
            {unit}
          </Box>
        )}
      </Typography>
      {hint && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 1 }}
        >
          {hint}
        </Typography>
      )}
    </Paper>
  );
}
export function EmptyState({
  title,
  description,
  icon: Icon = RadarRounded,
  action,
  compact = false,
}) {
  return (
    <Box sx={{ textAlign: "center", py: compact ? 3 : 6, px: 2 }}>
      <Box
        sx={{
          width: 48,
          height: 48,
          borderRadius: "14px",
          bgcolor: "#91bcfa0c",
          display: "grid",
          placeItems: "center",
          mx: "auto",
          mb: 2,
        }}
      >
        <Icon sx={{ color: "text.secondary", fontSize: 25 }} />
      </Box>
      <Typography variant="subtitle2">{title}</Typography>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 0.8, maxWidth: 440, mx: "auto" }}
      >
        {description}
      </Typography>
      {action && <Box sx={{ mt: 2 }}>{action}</Box>}
    </Box>
  );
}
export function StatusBadge({ value }) {
  return (
    <Chip
      label={value || "UNAVAILABLE"}
      color={statusColor(value)}
      variant="outlined"
    />
  );
}
export function Address({ value, label }) {
  const [notice, setNotice] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Address copied");
    } catch (_) {
      setNotice(
        "Copy unavailable. Select the full address in execution details."
      );
    }
  };
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.4,
        maxWidth: "100%",
      }}
    >
      <Tooltip title={value || "Address unavailable"}>
        <Typography component="span" variant="caption" className="mono">
          {label || shortAddress(value)}
        </Typography>
      </Tooltip>
      {value && (
        <IconButton
          aria-label={`Copy ${value}`}
          onClick={copy}
          size="small"
          sx={{ p: 0.4 }}
        >
          <ContentCopyRounded sx={{ fontSize: 13 }} />
        </IconButton>
      )}
      <Snackbar
        open={Boolean(notice)}
        message={notice}
        autoHideDuration={2500}
        onClose={() => setNotice("")}
      />
    </Box>
  );
}
export function RouteFlow({ legs = [] }) {
  return (
    <Box className="route-flow">
      {legs.map((leg, i) => (
        <React.Fragment key={`${leg.poolAddress}-${i}`}>
          <Box
            sx={{
              p: 1.2,
              border: "1px solid",
              borderColor: "divider",
              borderRadius: 2,
              minWidth: 110,
            }}
          >
            <Typography variant="body2" sx={{ fontWeight: 550 }}>
              {DEX_LABELS[leg.dex] || leg.dex}
            </Typography>
            <Address value={leg.poolAddress} />
            {leg.feeTier > 0 && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block" }}
              >
                {leg.feeTier / 10000}% pool fee
              </Typography>
            )}
          </Box>
          {i < legs.length - 1 && (
            <ArrowForwardRounded
              sx={{ color: "text.secondary", fontSize: 18 }}
            />
          )}
        </React.Fragment>
      ))}
    </Box>
  );
}
