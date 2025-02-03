// src/components/Trades.js

import React, { useState, useEffect } from 'react';
import axios from '../axiosConfig';
import './Trades.css';

const Trades = () => {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchTrades = async () => {
    try {
      const response = await axios.get('/trades');
      setTrades(response.data);
    } catch (error) {
      console.error('Error fetching trades:', error);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchTrades();
    const interval = setInterval(fetchTrades, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="trades-component">
      {loading ? (
        <p>Loading trades...</p>
      ) : trades.length > 0 ? (
        <table className="trades-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Amount (ETH)</th>
              <th>Token</th>
              <th>Tx Hash</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, index) => (
              <tr key={index}>
                <td>{new Date(trade.timestamp).toLocaleString()}</td>
                <td>{trade.type.toUpperCase()}</td>
                <td>{trade.amountIn}</td>
                <td>
                  <a
                    href={`https://etherscan.io/address/${trade.tokenAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {trade.tokenAddress.slice(0, 6)}...{trade.tokenAddress.slice(-4)}
                  </a>
                </td>
                <td>
                  <a
                    href={`https://etherscan.io/tx/${trade.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {trade.txHash.slice(0, 10)}...
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No trades executed yet.</p>
      )}
    </div>
  );
};

export default Trades;
