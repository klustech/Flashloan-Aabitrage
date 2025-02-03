// src/components/OpenTrades.js

import React, { useState, useEffect } from 'react';
import axios from '../axiosConfig';
import './OpenTrades.css';

const OpenTrades = () => {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchTrades = async () => {
    try {
      // Assumed endpoint that returns all trades (open and closed)
      const response = await axios.get('/all-trades');
      // Filter for open trades (assumed to be trades with type "buy")
      const openTrades = response.data.filter(trade => trade.type === 'buy');
      setTrades(openTrades);
    } catch (error) {
      console.error('Error fetching open trades:', error);
    }
    setLoading(false);
  };

  const handleAdjust = async (trade) => {
    // Prompt the user for new profit and stop loss thresholds
    const newProfit = prompt("Enter new profit threshold (%)", trade.profitThreshold || "");
    const newStopLoss = prompt("Enter new stop loss threshold (%)", trade.stopLossThreshold || "");
    if (newProfit && newStopLoss) {
      try {
        await axios.post('/update-trade', {
          tradeId: trade.id,
          profitThreshold: parseFloat(newProfit),
          stopLossThreshold: parseFloat(newStopLoss)
        });
        alert("Trade settings updated.");
        fetchTrades();
      } catch (error) {
        console.error("Error updating trade:", error);
        alert("Failed to update trade.");
      }
    }
  };

  const handleSell = async (trade) => {
    if (window.confirm("Are you sure you want to sell this token?")) {
      try {
        await axios.post('/manual-sell', {
          tokenAddress: trade.tokenAddress
        });
        alert("Sell order placed.");
        fetchTrades();
      } catch (error) {
        console.error("Error selling token:", error);
        alert("Failed to sell token.");
      }
    }
  };

  useEffect(() => {
    fetchTrades();
    const interval = setInterval(fetchTrades, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="open-trades">
      <h3>Open Trades</h3>
      {loading ? (
        <p>Loading open trades...</p>
      ) : trades.length > 0 ? (
        <table className="trades-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Token</th>
              <th>Amount (ETH)</th>
              <th>Current State</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, index) => (
              <tr key={index}>
                <td>{new Date(trade.timestamp).toLocaleString()}</td>
                <td>
                  <a href={`https://etherscan.io/address/${trade.tokenAddress}`} target="_blank" rel="noopener noreferrer">
                    {trade.tokenAddress.slice(0, 6)}...{trade.tokenAddress.slice(-4)}
                  </a>
                </td>
                <td>{trade.amountIn}</td>
                <td>{trade.state || "Holding"}</td>
                <td>
                  <button className="button" onClick={() => handleAdjust(trade)}>Adjust</button>
                  <button className="button" onClick={() => handleSell(trade)}>Sell</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No open trades available.</p>
      )}
    </div>
  );
};

export default OpenTrades;
