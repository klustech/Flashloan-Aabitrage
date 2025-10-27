// src/components/ProfitDetermination.js
import React, { useState, useEffect } from "react";
import axios from "../config/axiosConfig";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./ProfitDetermination.css";

const ProfitDetermination = () => {
  const [profitData, setProfitData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchProfitData = async () => {
    try {
      setLoading(true);
      setError(null);
      // Backend exposes /api/simulate-profit
      const response = await axios.get("/api/simulate-profit");
      if (response.status === 204 || !response.data) {
        setProfitData(null);
      } else {
        setProfitData(response.data);
      }
    } catch (err) {
      console.error("Error fetching profit simulation data:", err);
      setError("Failed to fetch profit simulation data.");
      toast.error("Failed to fetch profit simulation data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfitData();
    const interval = setInterval(fetchProfitData, 300000); // refresh every 5 minutes
    return () => clearInterval(interval);
  }, []); // API_BASE_URL is a compile-time constant

  if (loading) return <p>Loading profit simulation data...</p>;
  if (error) return <p className="error">{error}</p>;
  if (!profitData)
    return <p>No recent profit simulation data is currently available.</p>;

  const formatNumber = (value, digits = 4) => {
    if (typeof value !== "number" || Number.isNaN(value)) return "—";
    return value.toFixed(digits);
  };

  const timestampLabel = profitData.timestamp
    ? new Date(profitData.timestamp).toLocaleString()
    : "—";
  const isProfitable =
    typeof profitData.profit === "number" && profitData.profit > 0;

  return (
    <div className="profit-determination card">
      <div className="card-body">
        <h5 className="card-title">Profit Determination Simulation</h5>
        <div className="profit-item">
          <span className="profit-label">Route:</span>
          <span className="profit-value">{profitData.route ?? "—"}</span>
        </div>
        <div className="profit-item">
          <span className="profit-label">Chain:</span>
          <span className="profit-value">{profitData.chain ?? "—"}</span>
        </div>
        <div className="profit-item">
          <span className="profit-label">Timestamp:</span>
          <span className="profit-value">{timestampLabel}</span>
        </div>
        {profitData.aborted && (
          <div className="profit-item">
            <span className="profit-label">Status:</span>
            <span className="profit-value loss">
              {profitData.reason
                ? `Aborted (${profitData.reason})`
                : "Aborted"}
            </span>
          </div>
        )}
        <div className="profit-grid">
          <div className="profit-item">
            <span className="profit-label">Borrow Amount (DAI):</span>
            <span className="profit-value">
              {formatNumber(profitData.borrowAmount)}
            </span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Estimated Output (DAI):</span>
            <span className="profit-value">
              {formatNumber(profitData.estimatedOut)}
            </span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Simulated Output (DAI):</span>
            <span className="profit-value">
              {formatNumber(profitData.simulatedOutput)}
            </span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Estimated Gas Cost (DAI):</span>
            <span className="profit-value">
              {formatNumber(profitData.gasCostDAI)}
            </span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Estimated Gas Cost (ETH):</span>
            <span className="profit-value">
              {formatNumber(profitData.gasCostETH)}
            </span>
          </div>
          <div className="profit-item">
            <span className="profit-label">
              Total Cost (with Premium) (DAI):
            </span>
            <span className="profit-value">
              {formatNumber(profitData.totalCostDAI)}
            </span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Flash-Loan Premium (DAI):</span>
            <span className="profit-value">
              {formatNumber(profitData.premiumDAI)}
            </span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Net Profit (DAI):</span>
            <span
              className={`profit-value ${
                isProfitable ? "profit" : "loss"
              }`}
            >
              {formatNumber(profitData.profit)}
            </span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Arbitrage Opportunity:</span>
            <span className="profit-value">
              {isProfitable ? "Yes" : "No"}
            </span>
          </div>
          {profitData.gasPriceGwei && (
            <div className="profit-item">
              <span className="profit-label">Gas Price (Gwei):</span>
              <span className="profit-value">
                {formatNumber(profitData.gasPriceGwei)}
              </span>
            </div>
          )}
          {profitData.gasUsed && (
            <div className="profit-item">
              <span className="profit-label">Gas Used (units):</span>
              <span className="profit-value">{profitData.gasUsed}</span>
            </div>
          )}
        </div>
        <button onClick={fetchProfitData} className="refresh-button">
          Refresh Simulation
        </button>
        <ToastContainer position="bottom-right" />
      </div>
    </div>
  );
};

export default ProfitDetermination;
