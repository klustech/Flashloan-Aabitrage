// src/components/ProfitDetermination.js
import React, { useState, useEffect } from 'react';
import axios from '../config/axiosConfig';
import { toast } from 'react-toastify';
import './ProfitDetermination.css';

const ProfitDetermination = () => {
  const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:5000/api';
  const [profitData, setProfitData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchProfitData = async () => {
    try {
      setLoading(true);
      setError(null);
      // Assumes your backend now exposes an endpoint /api/profit-simulation
      const response = await axios.get(`${API_BASE_URL}/profit-simulation`);
      setProfitData(response.data);
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
  }, [API_BASE_URL]);

  if (loading) return <p>Loading profit simulation data...</p>;
  if (error) return <p className="error">{error}</p>;
  if (!profitData) return <p>No profit simulation data available.</p>;

  return (
    <div className="profit-determination card">
      <div className="card-body">
        <h5 className="card-title">Profit Determination Simulation</h5>
        <div className="profit-grid">
          <div className="profit-item">
            <span className="profit-label">Simulated Output (DAI):</span>
            <span className="profit-value">{profitData.simulatedOutput.toFixed(6)}</span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Estimated Gas Cost (DAI):</span>
            <span className="profit-value">{profitData.gasCostDAI.toFixed(6)}</span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Total Cost (with Premium) (DAI):</span>
            <span className="profit-value">{profitData.totalCostDAI.toFixed(6)}</span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Net Profit (DAI):</span>
            <span className={`profit-value ${profitData.profit > 0 ? 'profit' : 'loss'}`}>
              {profitData.profit.toFixed(6)}
            </span>
          </div>
          <div className="profit-item">
            <span className="profit-label">Arbitrage Opportunity:</span>
            <span className="profit-value">
              {profitData.profit > 0 ? 'Yes' : 'No'}
            </span>
          </div>
        </div>
        <button onClick={fetchProfitData} className="refresh-button">
          Refresh Simulation
        </button>
      </div>
    </div>
  );
};

export default ProfitDetermination;
