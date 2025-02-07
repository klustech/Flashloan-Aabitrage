// frontend/src/components/DetectedPairs.js

import React, { useEffect, useState } from 'react';
import axios from '../axiosConfig';
import './DetectedPairs.css';

const DetectedPairs = () => {
  const [pairs, setPairs] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchPairs = async () => {
    try {
      const response = await axios.get('/detected-pairs');
      setPairs(response.data);
    } catch (error) {
      console.error('Error fetching detected pairs:', error);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchPairs();
    const interval = setInterval(fetchPairs, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="detected-pairs">
      <h3>Detected Pairs</h3>
      {loading ? (
        <p>Loading pairs...</p>
      ) : pairs.length > 0 ? (
        <table className="pairs-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Token Address</th>
              <th>Pair Address</th>
              <th>Liquidity (ETH)</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((pair, index) => (
              <tr key={index}>
                <td>{new Date(pair.timestamp).toLocaleString()}</td>
                <td>
                  <a
                    href={`https://etherscan.io/address/${pair.tokenAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {pair.tokenAddress.slice(0, 6)}...{pair.tokenAddress.slice(-4)}
                  </a>
                </td>
                <td>
                  <a
                    href={`https://etherscan.io/address/${pair.pairAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {pair.pairAddress.slice(0, 6)}...{pair.pairAddress.slice(-4)}
                  </a>
                </td>
                <td>{pair.liquidity ? `${pair.liquidity} ETH` : 'N/A'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No detected pairs found.</p>
      )}
    </div>
  );
};

export default DetectedPairs;
