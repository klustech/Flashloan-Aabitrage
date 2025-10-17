// frontend/src/index.jsx

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { BrowserRouter } from "react-router-dom";
import Auth0ProviderWithNavigate from "./Auth0ProviderWithNavigate";
import "./index.css";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#FFD700" },
    background: { default: "#000", paper: "#111" },
  },
});

const container = document.getElementById("root");
const root = createRoot(container);

root.render(
  <BrowserRouter>
    <Auth0ProviderWithNavigate>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </Auth0ProviderWithNavigate>
  </BrowserRouter>
);
