// frontend/src/components/OpenTrades.js

import React, { useState, useEffect } from 'react';
import axios from '../axiosConfig';
import './OpenTrades.css';

const OpenTrades = () => {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchTrades = async () => {
    try {
      // Endpoint returns all trades; filter for open trades (type "buy" and state "Holding")
      const response = await axios.get('/all-trades');
      const validTrades = (response.data || []).filter(
        (trade) => trade && trade.type && trade.type.toLowerCase() === 'buy' && (!trade.state || trade.state.toLowerCase() === 'holding')
      );
      setTrades(validTrades);
    } catch (error) {
      console.error('Error fetching open trades:', error);
    }
    setLoading(false);
  };

  const handleAdjust = async (trade) => {
    if (!trade) return;
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
    if (!trade) return;
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
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, index) => (
              <tr key={index}>
                <td>{trade.timestamp ? new Date(trade.timestamp).toLocaleString() : "N/A"}</td>
                <td>
                  {trade.tokenAddress ? (
                    <a href={`https://etherscan.io/address/${trade.tokenAddress}`} target="_blank" rel="noopener noreferrer">
                      {trade.tokenAddress.slice(0, 6)}...{trade.tokenAddress.slice(-4)}
                    </a>
                  ) : (
                    "N/A"
                  )}
                </td>
                <td>{trade.amountIn || "N/A"}</td>
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
