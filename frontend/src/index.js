// frontend/src/index.js

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import "./index.css";
import App from "./App.jsx";
import reportWebVitals from "./reportWebVitals";
import Auth0ProviderWithNavigate from "./Auth0ProviderWithNavigate";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#FFD700" },
    background: { default: "#000", paper: "#111" },
  },
});

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <Auth0ProviderWithNavigate>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <App />
        </ThemeProvider>
      </Auth0ProviderWithNavigate>
    </BrowserRouter>
  </React.StrictMode>
);

reportWebVitals();
