import { createTheme } from "@mui/material/styles";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#7ce9bf", contrastText: "#10261e" },
    secondary: { main: "#a8baff" },
    success: { main: "#7ce9bf" },
    warning: { main: "#efc477" },
    error: { main: "#ff929b" },
    info: { main: "#91bcfa" },
    background: { default: "#0b111b", paper: "#121c2a" },
    text: { primary: "#edf3fc", secondary: "#9caec4", disabled: "#748399" },
    divider: "#263345",
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
    h4: { fontSize: "1.9rem", fontWeight: 650, letterSpacing: "-.055em" },
    h5: { fontSize: "1.45rem", fontWeight: 650, letterSpacing: "-.035em" },
    h6: { fontSize: "1.03rem", fontWeight: 600, letterSpacing: "-.015em" },
    subtitle2: { fontWeight: 600 },
    body1: { fontSize: ".9rem", lineHeight: 1.65 },
    body2: { fontSize: ".82rem", lineHeight: 1.65 },
    caption: { fontSize: ".73rem", lineHeight: 1.6 },
    button: { fontSize: ".8rem", fontWeight: 600, textTransform: "none" },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { fontVariantNumeric: "tabular-nums" },
        a: { color: "#91bcfa" },
        "::selection": { background: "#7ce9bf40" },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: { backgroundImage: "none", border: "1px solid #263345" },
      },
    },
    MuiCard: { styleOverrides: { root: { boxShadow: "none" } } },
    MuiCardContent: {
      styleOverrides: {
        root: { padding: 24, "&:last-child": { paddingBottom: 24 } },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 8, padding: "9px 15px", whiteSpace: "nowrap" },
        outlined: { borderColor: "#34445b" },
      },
    },
    MuiIconButton: { styleOverrides: { root: { borderRadius: 8 } } },
    MuiChip: {
      defaultProps: { size: "small" },
      styleOverrides: {
        root: { borderRadius: 6, fontWeight: 550, height: 26 },
        filled: { backgroundColor: "#223046" },
        colorSuccess: { backgroundColor: "#7ce9bf16", color: "#7ce9bf" },
        colorInfo: { backgroundColor: "#91bcfa16", color: "#91bcfa" },
        colorWarning: { backgroundColor: "#efc47716", color: "#efc477" },
        colorError: { backgroundColor: "#ff929b16", color: "#ff929b" },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { borderColor: "#263345", padding: "15px 18px" },
        head: {
          color: "#9caec4",
          fontSize: ".69rem",
          fontWeight: 600,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          backgroundColor: "#141f2e",
          whiteSpace: "nowrap",
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: { "&.MuiTableRow-hover:hover": { backgroundColor: "#7ce9bf05" } },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: { borderRadius: 8, backgroundColor: "#0f1825" },
        notchedOutline: { borderColor: "#34445b" },
      },
    },
    MuiInputLabel: { styleOverrides: { root: { fontSize: ".85rem" } } },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 9, border: "1px solid #263345" },
        message: { minWidth: 0, overflowWrap: "anywhere" },
      },
    },
    MuiDialog: { styleOverrides: { paper: { backgroundColor: "#121c2a" } } },
    MuiDialogTitle: {
      styleOverrides: { root: { fontSize: "1.15rem", fontWeight: 600 } },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          borderColor: "#34445b",
          textTransform: "none",
          padding: "6px 12px",
          fontSize: ".75rem",
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { borderRadius: 6, height: 5, backgroundColor: "#263345" },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { backgroundColor: "#263345", fontSize: ".75rem" },
      },
    },
    MuiSkeleton: { styleOverrides: { root: { borderRadius: 8 } } },
  },
});
export default theme;
